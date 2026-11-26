// Package auth is the OIDC client (authorization code + PKCE, client_secret_post)
// and the sealed session cookie. It is adapted from the house services
// (SecretDrop, QR-Forge, DocDrop) without the back-channel logout endpoint: the
// identity provider does not send one, and it would be a second POST route for
// no reason.
//
// Nothing here names a provider. Every endpoint comes from discovery.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config is one OIDC client. RequiredGroup, when set, must appear in the
// user's `groups` (from UserInfo or, failing that, from the access token).
type Config struct {
	Issuer         string
	PublicOrigin   string
	InternalOrigin string
	ClientID       string
	ClientSecret   string
	RedirectURI    string
	RequiredGroup  string
	Timeout        time.Duration
}

type Endpoints struct {
	Authorization string
	Token         string
	UserInfo      string
	EndSession    string
}

type Identity struct {
	Sub    string
	Email  string
	Name   string
	Groups []string
}

// ErrNotMember means the sign-in worked but the account is not in the group
// this tool requires. It is told apart so the page can say so.
var ErrNotMember = errors.New("oidc: account is not a member of the required group")

// ValidURL accepts https, or http when the URL is not public-facing or points at
// loopback. No user info, query or fragment; trailing slashes removed.
func ValidURL(raw string, publicFacing bool) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && (!publicFacing || loopback)) {
		return ""
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return strings.TrimRight(u.String(), "/")
}

func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// ConfigFromEnv reads <PREFIX>_OIDC_*. It returns nil when anything required is
// missing or invalid: then nobody can sign in, and the server says so.
func ConfigFromEnv(prefix string, getenv func(string) string) *Config {
	get := func(k string) string { return strings.TrimSpace(getenv(prefix + "_" + k)) }
	issuer := ValidURL(get("OIDC_ISSUER"), true)
	internal := get("OIDC_INTERNAL_BASE")
	if internal == "" && issuer != "" {
		internal = originOf(issuer)
	}
	internal = ValidURL(internal, false)
	redirect := ValidURL(get("OIDC_REDIRECT_URI"), true)
	clientID, secret := get("OIDC_CLIENT_ID"), get("OIDC_CLIENT_SECRET")
	if clientID == "" || secret == "" || issuer == "" || internal == "" || redirect == "" {
		return nil
	}
	timeout := 10 * time.Second
	// An empty variable falls back to the default, not to zero.
	if n, err := strconv.Atoi(get("OIDC_TIMEOUT_MS")); err == nil {
		timeout = time.Duration(min(60_000, max(1_000, n))) * time.Millisecond
	}
	return &Config{Issuer: issuer, PublicOrigin: originOf(issuer), InternalOrigin: internal,
		ClientID: clientID, ClientSecret: secret, RedirectURI: redirect,
		RequiredGroup: get("OIDC_REQUIRED_GROUP"), Timeout: timeout}
}

// rebase keeps an endpoint's path and swaps its origin: the provider chooses
// the path, we choose the address depending on who calls it (the browser goes
// to the public origin, the server to the internal one). Host and port are
// replaced together: leaking the internal port into a browser redirect has
// happened before in the house.
func rebase(endpoint, target string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	t, err := url.Parse(target)
	if err != nil {
		return endpoint
	}
	u.Scheme, u.Host = t.Scheme, t.Host
	return u.String()
}

// Client talks to the provider. Discovery is cached for ten minutes; when the
// provider is briefly unreachable the stale copy is used rather than switching
// sign-in off.
type Client struct {
	cfg    *Config
	http   *http.Client
	mu     sync.Mutex
	cached *Endpoints
	when   time.Time
	ttl    time.Duration
	now    func() time.Time
}

func NewClient(cfg *Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout, CheckRedirect: noRedirects},
		ttl: 10 * time.Minute, now: time.Now}
}

// The provider never needs to redirect a back-end call; following one would let
// a misconfigured endpoint send our client secret elsewhere.
func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func (c *Client) Config() *Config { return c.cfg }

func (c *Client) Discover(ctx context.Context) (*Endpoints, error) {
	c.mu.Lock()
	if c.cached != nil && c.now().Sub(c.when) < c.ttl {
		e := c.cached
		c.mu.Unlock()
		return e, nil
	}
	stale := c.cached
	c.mu.Unlock()

	doc, err := c.getJSON(ctx, strings.TrimRight(rebase(c.cfg.Issuer, c.cfg.InternalOrigin), "/")+"/.well-known/openid-configuration", "")
	if err != nil {
		if stale != nil {
			return stale, nil
		}
		return nil, err
	}
	str := func(k string) string { v, _ := doc[k].(string); return v }
	e := &Endpoints{
		Authorization: rebase(str("authorization_endpoint"), c.cfg.PublicOrigin),
		Token:         rebase(str("token_endpoint"), c.cfg.InternalOrigin),
		UserInfo:      rebase(str("userinfo_endpoint"), c.cfg.InternalOrigin),
	}
	if str("authorization_endpoint") == "" || str("token_endpoint") == "" || str("userinfo_endpoint") == "" {
		return nil, errors.New("discovery: incomplete document")
	}
	if v := str("end_session_endpoint"); v != "" {
		e.EndSession = rebase(v, c.cfg.PublicOrigin)
	}
	c.mu.Lock()
	c.cached, c.when = e, c.now()
	c.mu.Unlock()
	return e, nil
}

func (c *Client) getJSON(ctx context.Context, target, bearer string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: status %d", req.URL.Path, res.StatusCode)
	}
	var doc map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// RandomToken is 32 random bytes, base64url: a PKCE verifier (43 characters) or a state.
func RandomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (c *Client) AuthorizeURL(ctx context.Context, state, challenge string) (string, error) {
	e, err := c.Discover(ctx)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(e.Authorization)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("client_id", c.cfg.ClientID)
	q.Set("redirect_uri", c.cfg.RedirectURI)
	q.Set("response_type", "code")
	// No "groups" scope on purpose: providers carry membership in their own
	// claims, and asking for an unknown scope makes some of them refuse.
	q.Set("scope", "openid email profile")
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Exchange trades the code for an access token, asks UserInfo who it is, and
// applies the group gate. Identity comes from UserInfo, not from an id_token.
func (c *Client) Exchange(ctx context.Context, code, verifier string) (*Identity, error) {
	e, err := c.Discover(ctx)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {c.cfg.RedirectURI}, "client_id": {c.cfg.ClientID},
		"client_secret": {c.cfg.ClientSecret}, "code_verifier": {verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.Token, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		// The provider's body is not repeated anywhere: it may echo credentials.
		return nil, fmt.Errorf("token endpoint: status %d", res.StatusCode)
	}
	var tokens struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&tokens); err != nil || tokens.AccessToken == "" {
		return nil, errors.New("token endpoint: no access_token")
	}

	info, err := c.getJSON(ctx, e.UserInfo, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	str := func(k string) string { v, _ := info[k].(string); return v }
	id := &Identity{Sub: str("sub"), Email: strings.ToLower(str("email")), Name: str("name"), Groups: stringList(info["groups"])}
	if id.Sub == "" {
		return nil, errors.New("userinfo: no sub")
	}
	if len(id.Groups) == 0 {
		// Some providers answer UserInfo with little
		// more than the subject and carry the groups in the access token, put
		// there by a claims hook. UserInfo has just accepted this very token, and
		// it came straight from the token endpoint over the back channel, so its
		// payload can be read without verifying the signature again.
		claims := accessTokenClaims(tokens.AccessToken)
		if s, _ := claims["sub"].(string); s != "" && s != id.Sub {
			return nil, errors.New("access token and userinfo disagree on the subject")
		}
		id.Groups = stringList(claims["groups"])
		if id.Email == "" {
			id.Email, _ = claims["email"].(string)
		}
	}
	if c.cfg.RequiredGroup != "" && !slices.Contains(id.Groups, c.cfg.RequiredGroup) {
		return nil, ErrNotMember
	}
	return id, nil
}

func stringList(v any) []string {
	items, _ := v.([]any)
	out := make([]string, 0, len(items))
	for _, it := range items {
		if s, ok := it.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func accessTokenClaims(raw string) map[string]any {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return nil
	}
	return claims
}

// SafeNext only allows paths on this site. Without it, ?next=https://elsewhere
// would turn sign-in into an open redirector.
func SafeNext(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if r > 0x1F && r != 0x7F {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, "/\\") {
		return "/"
	}
	return s
}
