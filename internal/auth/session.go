package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

// Sealer seals small JSON values into cookies with AES-256-GCM. The server keeps
// no sessions: what a cookie says is all there is, and nobody can read or forge
// it without the secret. The audience (the tool's name) is part of the
// authenticated data, so a PageForge cookie is worthless to InkBar even if they
// shared a secret by mistake.
type Sealer struct {
	aead     cipher.AEAD
	audience string
	now      func() time.Time
}

// MinSecretBytes: shorter secrets are refused at start-up rather than used.
const MinSecretBytes = 32

func NewSealer(secret, audience string) (*Sealer, error) {
	if len(secret) < MinSecretBytes {
		return nil, errors.New("session secret must be at least 32 bytes")
	}
	key := sha256.Sum256([]byte("pageforge-session-v1\x00" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{aead: aead, audience: audience, now: time.Now}, nil
}

// Seal stores v with an expiry. purpose separates the kinds of cookie: a login
// state cookie can never be replayed as a session.
func (s *Sealer) Seal(purpose string, v any, ttl time.Duration) (string, error) {
	body, err := json.Marshal(struct {
		Exp int64 `json:"exp"`
		V   any   `json:"v"`
	}{s.now().Add(ttl).Unix(), v})
	if err != nil {
		return "", err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := s.aead.Seal(nonce, nonce, body, []byte(s.audience+"\x00"+purpose))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Open fills out and reports whether the cookie is genuine and not expired. It
// never says why not: the client does not need to know, and an attacker
// should not.
func (s *Sealer) Open(purpose, token string, out any) bool {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) < s.aead.NonceSize()+s.aead.Overhead() {
		return false
	}
	nonce, ct := raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():]
	body, err := s.aead.Open(nil, nonce, ct, []byte(s.audience+"\x00"+purpose))
	if err != nil {
		return false
	}
	var env struct {
		Exp int64           `json:"exp"`
		V   json.RawMessage `json:"v"`
	}
	if json.Unmarshal(body, &env) != nil || env.Exp <= s.now().Unix() {
		return false
	}
	return json.Unmarshal(env.V, out) == nil
}

// Session is what the session cookie carries. It is everything the server
// knows about who is using it, and it is not stored anywhere.
type Session struct {
	Sub   string `json:"sub"`
	Email string `json:"email,omitempty"`
	Name  string `json:"name,omitempty"`
	Iat   int64  `json:"iat"`
}

// LoginState travels in a short-lived cookie between /auth/login and the callback.
type LoginState struct {
	Verifier string `json:"verifier"`
	State    string `json:"state"`
	Next     string `json:"next"`
}
