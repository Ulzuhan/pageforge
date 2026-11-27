package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/Ulzuhan/pageforge/internal/auth"
)

func testDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":          {Data: []byte("<!doctype html><title>landing</title>")},
		"app/index.html":      {Data: []byte("<!doctype html><title>the tool</title>")},
		"assets/app-abc12.js": {Data: []byte("console.log(1)")},
		"pdfjs/wasm/x.wasm":   {Data: []byte("\x00asm")},
	}
}

type provider struct {
	srv    *httptest.Server
	groups []string
}

func newProvider(t *testing.T) *provider {
	p := &provider{groups: []string{"pageforge"}}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := p.srv.URL + "/realms/x/protocol/openid-connect"
		switch {
		case strings.HasSuffix(r.URL.Path, "/.well-known/openid-configuration"):
			_ = json.NewEncoder(w).Encode(map[string]string{"issuer": p.srv.URL + "/realms/x",
				"authorization_endpoint": base + "/auth", "token_endpoint": base + "/token",
				"userinfo_endpoint": base + "/userinfo", "end_session_endpoint": base + "/logout"})
		case strings.HasSuffix(r.URL.Path, "/token"):
			payload, _ := json.Marshal(map[string]any{"sub": "u1", "groups": p.groups})
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "h." + base64.RawURLEncoding.EncodeToString(payload) + ".s"})
		case strings.HasSuffix(r.URL.Path, "/userinfo"):
			_ = json.NewEncoder(w).Encode(map[string]string{"sub": "u1", "email": "ana@example.com"})
		}
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func newTestServer(t *testing.T, p *provider) (*Server, http.Handler) {
	sealer, err := auth.NewSealer("0123456789abcdef0123456789abcdef", "pageforge")
	if err != nil {
		t.Fatal(err)
	}
	opt := Options{Sealer: sealer, SecureCookies: true, AccountURL: "https://account.example.com"}
	if p != nil {
		opt.OIDC = auth.NewClient(&auth.Config{Issuer: p.srv.URL + "/realms/x", PublicOrigin: p.srv.URL,
			InternalOrigin: p.srv.URL, ClientID: "cid", ClientSecret: "s", RedirectURI: "https://page.example.com/auth/callback",
			RequiredGroup: "pageforge", Timeout: 5 * time.Second})
	}
	s := New(Tool{Name: "pageforge", Title: "PageForge", Dist: testDist()}, opt)
	return s, s.Handler()
}

func do(h http.Handler, method, target string, mod ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for _, m := range mod {
		m(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestOnlyGetHeadAndLogout(t *testing.T) {
	_, h := newTestServer(t, nil)
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "PROPFIND"} {
		for _, p := range []string{"/", "/app/", "/api/session", "/upload", "/auth/login", "/assets/app-abc12.js"} {
			if rec := do(h, m, p); rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 405", m, p, rec.Code)
			}
		}
	}
	if rec := do(h, "PUT", "/auth/logout"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("only POST is allowed on logout, PUT got %d", rec.Code)
	}
}

func TestNoRouteTakesABody(t *testing.T) {
	_, h := newTestServer(t, nil)
	withBody := func(r *http.Request) {
		r.Body = http.NoBody
		r.ContentLength = 10
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	for _, c := range []struct{ m, p string }{{"GET", "/"}, {"GET", "/api/session"}, {"POST", "/auth/logout"}} {
		if rec := do(h, c.m, c.p, withBody); rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s with a body = %d, want 405", c.m, c.p, rec.Code)
		}
	}
	chunked := func(r *http.Request) { r.TransferEncoding = []string{"chunked"} }
	if rec := do(h, "GET", "/", chunked); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("chunked GET = %d, want 405", rec.Code)
	}
}

func TestHeadersEverywhere(t *testing.T) {
	_, h := newTestServer(t, nil)
	for _, p := range []string{"/", "/app/", "/healthz", "/nope", "/assets/app-abc12.js", "/pdfjs/wasm/x.wasm"} {
		rec := do(h, "GET", p)
		if rec.Header().Get("Content-Security-Policy") != CSP {
			t.Errorf("%s: missing CSP", p)
		}
		for _, k := range []string{"X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy"} {
			if rec.Header().Get(k) == "" {
				t.Errorf("%s: missing %s", p, k)
			}
		}
	}
	if !strings.Contains(CSP, "'wasm-unsafe-eval'") || strings.Contains(CSP, "'unsafe-eval'") || strings.Contains(CSP, "'unsafe-inline'") {
		t.Error("the CSP allows wasm and nothing else that evaluates code")
	}
	if ct := do(h, "GET", "/pdfjs/wasm/x.wasm").Header().Get("Content-Type"); ct != "application/wasm" {
		t.Errorf("wasm served as %q", ct)
	}
	if cc := do(h, "GET", "/assets/app-abc12.js").Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("hashed assets should be immutable, got %q", cc)
	}
}

func TestGate(t *testing.T) {
	p := newProvider(t)
	_, h := newTestServer(t, p)

	if rec := do(h, "GET", "/"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "landing") {
		t.Fatalf("the landing page is public: %d", rec.Code)
	}
	rec := do(h, "GET", "/app/")
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/auth/login?next=%2Fapp%2F" {
		t.Fatalf("the tool needs a session: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := do(h, "GET", "/api/session"); rec.Code != http.StatusUnauthorized {
		t.Errorf("/api/session without a session = %d", rec.Code)
	}

	// login: PKCE, state cookie, redirect to the provider
	rec = do(h, "GET", "/auth/login?next=/app/")
	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("login = %d", rec.Code)
	}
	loc, _ := url.Parse(rec.Header().Get("Location"))
	state := loc.Query().Get("state")
	var login *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "__Host-pageforge_login" {
			login = c
		}
	}
	if login == nil || !login.HttpOnly || !login.Secure || login.SameSite != http.SameSiteLaxMode {
		t.Fatalf("login cookie: %+v", login)
	}

	callback := func(st string) *httptest.ResponseRecorder {
		return do(h, "GET", "/auth/callback?code=c&state="+st, func(r *http.Request) { r.AddCookie(login) })
	}
	if rec := callback("forged"); rec.Header().Get("Location") != "/?error=signin" {
		t.Errorf("a foreign state must fail: %s", rec.Header().Get("Location"))
	}

	p.groups = []string{"inkbar"}
	if rec := callback(state); rec.Header().Get("Location") != "/?error=access" || sessionCookie(rec) != nil {
		t.Errorf("a non-member gets no session and is told why: %s", rec.Header().Get("Location"))
	}
	p.groups = []string{"pageforge"}
	rec = callback(state)
	sess := sessionCookie(rec)
	if rec.Header().Get("Location") != "/app/" || sess == nil || sess.MaxAge != 7200 {
		t.Fatalf("member: %s %+v", rec.Header().Get("Location"), sess)
	}
	withSession := func(r *http.Request) { r.AddCookie(sess) }
	if rec := do(h, "GET", "/app/", withSession); rec.Code != 200 || !strings.Contains(rec.Body.String(), "the tool") {
		t.Errorf("signed in, the tool loads: %d", rec.Code)
	}
	rec = do(h, "GET", "/api/session", withSession)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "ana@example.com") || !strings.Contains(rec.Body.String(), "account.example.com") {
		t.Errorf("/api/session = %d %s", rec.Code, rec.Body.String())
	}

	// logout: same origin only
	if rec := do(h, "POST", "/auth/logout", withSession, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site logout = %d", rec.Code)
	}
	rec = do(h, "POST", "/auth/logout", withSession, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-origin") })
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "/logout") {
		t.Errorf("logout = %d %s", rec.Code, rec.Body.String())
	}
	if c := sessionCookie(rec); c == nil || c.MaxAge >= 0 {
		t.Errorf("logout must clear the session cookie: %+v", c)
	}
}

func TestLoginWithoutConfiguration(t *testing.T) {
	_, h := newTestServer(t, nil)
	if rec := do(h, "GET", "/auth/login"); rec.Header().Get("Location") != "/?error=unconfigured" {
		t.Errorf("without OIDC, sign-in says so: %s", rec.Header().Get("Location"))
	}
}

func sessionCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == "__Host-pageforge_session" {
			return c
		}
	}
	return nil
}

func TestOptionsFromEnv(t *testing.T) {
	env := map[string]string{"INKBAR_SESSION_SECRET": "short", "INKBAR_OIDC_ISSUER": "https://id.example.com",
		"INKBAR_OIDC_CLIENT_ID": "c", "INKBAR_OIDC_CLIENT_SECRET": "s", "INKBAR_OIDC_REDIRECT_URI": "https://ink.example.com/auth/callback",
		"INKBAR_ACCOUNT_URL": "http://account.example.com"}
	opt, warn := OptionsFromEnv("inkbar", "INKBAR", func(k string) string { return env[k] })
	if opt.OIDC != nil || opt.AccountURL != "" || len(warn) != 2 || !opt.SecureCookies || opt.Indexable {
		t.Errorf("a short secret switches sign-in off, an http account URL is hidden: %+v %v", opt, warn)
	}
	for v, want := range map[string]bool{"1": true, " 1 ": true, "true": false, "yes": false, "0": false} {
		opt, warn := OptionsFromEnv("pageforge", "PAGEFORGE", func(k string) string {
			if k == "PAGEFORGE_INDEXABLE" {
				return v
			}
			return ""
		})
		warned := false
		for _, w := range warn {
			warned = warned || strings.Contains(w, "PAGEFORGE_INDEXABLE")
		}
		if opt.Indexable != want || warned == want {
			t.Errorf("PAGEFORGE_INDEXABLE=%q: indexable %v, warned %v", v, opt.Indexable, warned)
		}
	}
}

func TestSearchEnginesStayOutUntilAnnounced(t *testing.T) {
	_, h := newTestServer(t, nil)
	for _, p := range []string{"/", "/app/", "/healthz", "/nope", "/robots.txt", "/assets/app-abc12.js"} {
		if got := do(h, "GET", p).Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
			t.Errorf("%s: X-Robots-Tag %q, want noindex", p, got)
		}
	}
	rec := do(h, "GET", "/robots.txt")
	if rec.Code != http.StatusOK || rec.Body.String() != "User-agent: *\nDisallow: /\n" {
		t.Errorf("robots.txt before the announcement: %d %q", rec.Code, rec.Body.String())
	}

	h = New(Tool{Name: "pageforge", Title: "PageForge", Dist: testDist()}, Options{Indexable: true}).Handler()
	if got := do(h, "GET", "/").Header().Get("X-Robots-Tag"); got != "" {
		t.Errorf("once announced the landing page is indexable, got X-Robots-Tag %q", got)
	}
	body := do(h, "GET", "/robots.txt").Body.String()
	if strings.Contains(body, "Disallow: /\n") || !strings.Contains(body, "Disallow: /app/") || !strings.Contains(body, "Disallow: /auth/") {
		t.Errorf("once announced, robots.txt opens the landing page only: %q", body)
	}
}
