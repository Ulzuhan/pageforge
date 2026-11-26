// Package server is the whole HTTP surface of a tool: static files embedded in
// the binary, the sign-in gate, and nothing that can receive a file.
//
// The rule that makes "your file never leaves your browser" more than a
// promise: the only route that accepts anything but GET or HEAD is
// POST /auth/logout, and no route accepts a request body. Everything else gets
// 405. There is nowhere to upload to.
package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/Ulzuhan/pageforge/internal/auth"
)

// CSP is the policy measured in the spike (P1) with zero violations, page and
// worker: no 'unsafe-eval' (pdf.js 6.5 does not need it), 'wasm-unsafe-eval'
// for pdf.js' JBIG2, JPEG 2000 and ICC decoders, and Trusted Types with a single
// policy that only lets the two known worker scripts through.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; " +
	"img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
	"frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types workers"

// Tool describes one of the two products built from this repository.
type Tool struct {
	Name  string // "pageforge": cookie names, audience, logs
	Title string // "PageForge"
	Dist  fs.FS  // the Vite build: index.html (public), app/index.html (behind sign-in)
}

type Options struct {
	OIDC          *auth.Client // nil: sign-in is not configured
	Sealer        *auth.Sealer // nil: no sessions can be issued
	SessionTTL    time.Duration
	AccountURL    string // link to the account app; empty hides the button
	SecureCookies bool
	Log           *slog.Logger
}

type Server struct {
	tool  Tool
	opt   Options
	files http.Handler
}

func init() {
	// The Go defaults miss what pdf.js serves itself. .wasm in particular has to
	// be application/wasm or streaming compilation refuses it.
	for ext, typ := range map[string]string{
		".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".wasm": "application/wasm", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream",
		".ttf": "font/ttf", ".icc": "application/vnd.iccprofile", ".svg": "image/svg+xml",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}
}

func New(tool Tool, opt Options) *Server {
	if opt.Log == nil {
		opt.Log = slog.Default()
	}
	if opt.SessionTTL <= 0 {
		opt.SessionTTL = 2 * time.Hour
	}
	return &Server{tool: tool, opt: opt, files: http.FileServerFS(tool.Dist)}
}

func (s *Server) cookie(name string) string {
	// __Host- pins the cookie to this exact host, https and path /. It needs
	// Secure, so a local http run uses the plain name.
	if s.opt.SecureCookies {
		return "__Host-" + s.tool.Name + "_" + name
	}
	return s.tool.Name + "_" + name
}

func (s *Server) setCookie(w http.ResponseWriter, name, value string, maxAge time.Duration) {
	http.SetCookie(w, &http.Cookie{Name: s.cookie(name), Value: value, Path: "/", HttpOnly: true,
		Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: int(maxAge.Seconds())})
}

func (s *Server) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{Name: s.cookie(name), Value: "", Path: "/", HttpOnly: true,
		Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

func (s *Server) session(r *http.Request) *auth.Session {
	if s.opt.Sealer == nil {
		return nil
	}
	c, err := r.Cookie(s.cookie("session"))
	if err != nil {
		return nil
	}
	var sess auth.Session
	if !s.opt.Sealer.Open("session", c.Value, &sess) || sess.Sub == "" {
		return nil
	}
	return &sess
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /auth/login", s.login)
	mux.HandleFunc("GET /auth/callback", s.callback)
	mux.HandleFunc("POST /auth/logout", s.logout)
	mux.HandleFunc("GET /api/session", s.apiSession)
	mux.HandleFunc("GET /app", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /app/{rest...}", s.app)
	mux.HandleFunc("GET /{$}", s.static)
	mux.HandleFunc("GET /", s.static)
	return s.guard(mux)
}

// guard is the single layer every response goes through: methods and bodies
// first, then the headers. One layer, so that no handler can forget them.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", CSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		h.Set("Strict-Transport-Security", "max-age=31536000")

		logout := r.Method == http.MethodPost && r.URL.Path == "/auth/logout"
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !logout {
			h.Set("Allow", "GET, HEAD")
			s.refuse(w, r, "method")
			return
		}
		// No route takes a body, logout included. A request that carries one is
		// trying to send something, and there is nothing here to receive it.
		if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
			h.Set("Allow", "GET, HEAD")
			s.refuse(w, r, "body")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) refuse(w http.ResponseWriter, r *http.Request, why string) {
	// Only the method and the path: never headers, query or body.
	s.opt.Log.Info("refused", "tool", s.tool.Name, "why", why, "method", r.Method, "path", r.URL.Path)
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

// static serves the public build: the landing page and its assets. Nothing in
// it is secret; the tool itself only runs in the browser of someone signed in.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	p := path.Clean("/" + r.URL.Path)
	if p == "/app" || strings.HasPrefix(p, "/app/") {
		s.app(w, r)
		return
	}
	if strings.HasPrefix(p, "/assets/") {
		// Vite puts a content hash in every file name under /assets/.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if p != "/" {
		if _, err := fs.Stat(s.tool.Dist, strings.TrimPrefix(p, "/")); err != nil {
			http.NotFound(w, r)
			return
		}
	}
	s.files.ServeHTTP(w, r)
}

// app is the tool itself, behind sign-in. Only the HTML shell is gated: the
// scripts are the same for everyone and carry no data.
func (s *Server) app(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.session(r) == nil {
		next := "/app/"
		http.Redirect(w, r, "/auth/login?next="+url.QueryEscape(next), http.StatusFound)
		return
	}
	body, err := fs.ReadFile(s.tool.Dist, "app/index.html")
	if err != nil {
		http.Error(w, "the interface is missing from this build", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.opt.OIDC == nil || s.opt.Sealer == nil {
		http.Redirect(w, r, "/?error=unconfigured", http.StatusFound)
		return
	}
	verifier, err1 := auth.RandomToken()
	state, err2 := auth.RandomToken()
	if err := errors.Join(err1, err2); err != nil {
		http.Redirect(w, r, "/?error=signin", http.StatusFound)
		return
	}
	target, err := s.opt.OIDC.AuthorizeURL(r.Context(), state, auth.Challenge(verifier))
	if err != nil {
		s.opt.Log.Warn("sign-in: provider unavailable", "tool", s.tool.Name, "err", err)
		http.Redirect(w, r, "/?error=provider", http.StatusFound)
		return
	}
	sealed, err := s.opt.Sealer.Seal("login", auth.LoginState{Verifier: verifier, State: state,
		Next: auth.SafeNext(r.URL.Query().Get("next"))}, 10*time.Minute)
	if err != nil {
		http.Redirect(w, r, "/?error=signin", http.StatusFound)
		return
	}
	// Lax, not Strict: coming back from the provider is a cross-site navigation,
	// and Strict would withhold this cookie on exactly that request.
	s.setCookie(w, "login", sealed, 10*time.Minute)
	http.Redirect(w, r, target, http.StatusTemporaryRedirect)
}

func (s *Server) callback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	fail := func(code string) {
		s.clearCookie(w, "login")
		http.Redirect(w, r, "/?error="+code, http.StatusFound)
	}
	if s.opt.OIDC == nil || s.opt.Sealer == nil {
		fail("unconfigured")
		return
	}
	var st auth.LoginState
	c, err := r.Cookie(s.cookie("login"))
	q := r.URL.Query()
	// The state has to be the one we issued: it is what stops someone from
	// signing us in with THEIR code.
	if err != nil || !s.opt.Sealer.Open("login", c.Value, &st) || st.State == "" || q.Get("state") != st.State || q.Get("code") == "" {
		fail("signin")
		return
	}
	id, err := s.opt.OIDC.Exchange(r.Context(), q.Get("code"), st.Verifier)
	if errors.Is(err, auth.ErrNotMember) {
		s.opt.Log.Info("sign-in: not a member", "tool", s.tool.Name)
		fail("access")
		return
	}
	if err != nil {
		s.opt.Log.Warn("sign-in failed", "tool", s.tool.Name, "err", err)
		fail("signin")
		return
	}
	sealed, err := s.opt.Sealer.Seal("session", auth.Session{Sub: id.Sub, Email: id.Email, Name: id.Name, Iat: time.Now().Unix()}, s.opt.SessionTTL)
	if err != nil {
		fail("signin")
		return
	}
	s.setCookie(w, "session", sealed, s.opt.SessionTTL)
	s.clearCookie(w, "login")
	http.Redirect(w, r, auth.SafeNext(st.Next), http.StatusFound)
}

// sameOrigin refuses cross-site requests to the one POST there is. SameSite=Lax
// already keeps the cookie off cross-site POSTs; this is the second lock.
func sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site == "same-origin"
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !sameOrigin(r) {
		http.Error(w, "cross-origin request refused", http.StatusForbidden)
		return
	}
	s.clearCookie(w, "session")
	next := "/"
	if s.opt.OIDC != nil {
		if e, err := s.opt.OIDC.Discover(r.Context()); err == nil && e.EndSession != "" {
			next = e.EndSession
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"next": next})
}

// apiSession tells the page who is signed in, so it can show it. It is a GET
// and it returns only what the cookie already says.
func (s *Server) apiSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sess := s.session(r)
	if sess == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "not signed in"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": sess.Email, "name": sess.Name, "accountUrl": s.opt.AccountURL})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
