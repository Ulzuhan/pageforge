package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const secret = "0123456789abcdef0123456789abcdef"

func TestSealerRoundTripAndSeparation(t *testing.T) {
	s, err := NewSealer(secret, "pageforge")
	if err != nil {
		t.Fatal(err)
	}
	tok, err := s.Seal("session", Session{Sub: "u1", Email: "a@example.com"}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	var got Session
	if !s.Open("session", tok, &got) || got.Sub != "u1" {
		t.Fatalf("round trip failed: %+v", got)
	}
	if s.Open("login", tok, &got) {
		t.Error("a session cookie must not open as a login cookie")
	}
	other, _ := NewSealer(secret, "inkbar")
	if other.Open("session", tok, &got) {
		t.Error("a PageForge cookie must not open in InkBar, even with the same secret")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(tok)
	raw[len(raw)-1] ^= 1
	if s.Open("session", base64.RawURLEncoding.EncodeToString(raw), &got) {
		t.Error("a tampered cookie must not open")
	}
	s.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if s.Open("session", tok, &got) {
		t.Error("an expired cookie must not open")
	}
	if _, err := NewSealer("short", "x"); err == nil {
		t.Error("short secrets must be refused")
	}
}

func TestValidURLAndSafeNext(t *testing.T) {
	cases := map[string]string{
		"https://id.example.com/realm/": "https://id.example.com/realm",
		"http://id.example.com":         "",
		"http://127.0.0.1:9000":         "http://127.0.0.1:9000",
		"https://u:p@id.example.com":    "",
		"https://id.example.com/?x=1":   "",
	}
	for in, want := range cases {
		if got := ValidURL(in, true); got != want {
			t.Errorf("ValidURL(%q) = %q, want %q", in, got, want)
		}
	}
	if ValidURL("http://idp:8080", false) != "http://idp:8080" {
		t.Error("an internal base may be plain http")
	}
	for in, want := range map[string]string{"/app/": "/app/", "": "/", "//evil.example": "/",
		"/\\evil.example": "/", "https://evil.example": "/", "/a\nb": "/ab"} {
		if got := SafeNext(in); got != want {
			t.Errorf("SafeNext(%q) = %q, want %q", in, got, want)
		}
	}
}

// fakeProvider is a provider with Keycloak-shaped paths. UserInfo answers like
// providers that keep groups in the access token (no groups) unless groupsInUserInfo is set.
type fakeProvider struct {
	srv              *httptest.Server
	groups           []string
	groupsInUserInfo bool
	tokenSub         string
	gotForm          url.Values
}

func newFakeProvider(t *testing.T) *fakeProvider {
	f := &fakeProvider{groups: []string{"pageforge"}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := f.srv.URL + "/realms/x/protocol/openid-connect"
		switch {
		case strings.HasSuffix(r.URL.Path, "/.well-known/openid-configuration"):
			_ = json.NewEncoder(w).Encode(map[string]string{
				"issuer": f.srv.URL + "/realms/x", "authorization_endpoint": base + "/auth",
				"token_endpoint": base + "/token", "userinfo_endpoint": base + "/userinfo",
				"end_session_endpoint": base + "/logout"})
		case strings.HasSuffix(r.URL.Path, "/token"):
			_ = r.ParseForm()
			f.gotForm = r.PostForm
			sub := f.tokenSub
			if sub == "" {
				sub = "user-1"
			}
			payload, _ := json.Marshal(map[string]any{"sub": sub, "groups": f.groups})
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "h." + base64.RawURLEncoding.EncodeToString(payload) + ".s"})
		case strings.HasSuffix(r.URL.Path, "/userinfo"):
			out := map[string]any{"sub": "user-1", "email": "Ana@Example.com"}
			if f.groupsInUserInfo {
				out["groups"] = f.groups
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeProvider) client(group string) *Client {
	return NewClient(&Config{Issuer: "https://id.example.com/realms/x", PublicOrigin: "https://id.example.com",
		InternalOrigin: f.srv.URL, ClientID: "cid", ClientSecret: "csecret",
		RedirectURI: "https://page.example.com/auth/callback", RequiredGroup: group, Timeout: 5 * time.Second})
}

func TestAuthorizeURLUsesPublicOriginAndPKCE(t *testing.T) {
	f := newFakeProvider(t)
	u, err := f.client("pageforge").AuthorizeURL(context.Background(), "st", Challenge("v"))
	if err != nil {
		t.Fatal(err)
	}
	p, _ := url.Parse(u)
	if p.Host != "id.example.com" || p.Path != "/realms/x/protocol/openid-connect/auth" {
		t.Errorf("the browser must go to the public origin with the provider's path: %s", u)
	}
	q := p.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("client_id") != "cid" {
		t.Errorf("missing PKCE or client: %s", u)
	}
}

func TestExchangeGroupGate(t *testing.T) {
	ctx := context.Background()
	f := newFakeProvider(t)

	id, err := f.client("pageforge").Exchange(ctx, "code", "verifier")
	if err != nil || id.Sub != "user-1" || id.Email != "ana@example.com" {
		t.Fatalf("groups from the access token: %+v, %v", id, err)
	}
	if f.gotForm.Get("client_secret") != "csecret" || f.gotForm.Get("code_verifier") != "verifier" {
		t.Errorf("client_secret_post and the PKCE verifier must be sent: %v", f.gotForm)
	}

	if _, err := f.client("inkbar").Exchange(ctx, "code", "v"); !errors.Is(err, ErrNotMember) {
		t.Errorf("a member of another group must be refused, got %v", err)
	}

	f.groupsInUserInfo = true
	if _, err := f.client("pageforge").Exchange(ctx, "code", "v"); err != nil {
		t.Errorf("groups from UserInfo: %v", err)
	}
	f.groupsInUserInfo = false

	f.groups = nil
	if _, err := f.client("pageforge").Exchange(ctx, "code", "v"); !errors.Is(err, ErrNotMember) {
		t.Errorf("no groups at all must be refused, got %v", err)
	}
	if _, err := f.client("").Exchange(ctx, "code", "v"); err != nil {
		t.Errorf("without a required group the provider decides: %v", err)
	}

	f.groups, f.tokenSub = []string{"pageforge"}, "someone-else"
	if _, err := f.client("pageforge").Exchange(ctx, "code", "v"); err == nil {
		t.Error("an access token for a different subject must be refused")
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{
		"PAGEFORGE_OIDC_ISSUER": "https://id.example.com/realms/x", "PAGEFORGE_OIDC_CLIENT_ID": "c",
		"PAGEFORGE_OIDC_CLIENT_SECRET": "s", "PAGEFORGE_OIDC_REDIRECT_URI": "https://page.example.com/auth/callback",
		"PAGEFORGE_OIDC_REQUIRED_GROUP": "pageforge", "PAGEFORGE_OIDC_TIMEOUT_MS": "",
	}
	cfg := ConfigFromEnv("PAGEFORGE", func(k string) string { return env[k] })
	if cfg == nil || cfg.InternalOrigin != "https://id.example.com" || cfg.Timeout != 10*time.Second || cfg.RequiredGroup != "pageforge" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	env["PAGEFORGE_OIDC_REDIRECT_URI"] = "http://page.example.com/auth/callback"
	if ConfigFromEnv("PAGEFORGE", func(k string) string { return env[k] }) != nil {
		t.Error("a plain-http public redirect URI must switch sign-in off")
	}
}
