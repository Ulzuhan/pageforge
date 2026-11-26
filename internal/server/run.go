package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Ulzuhan/pageforge/internal/auth"
)

// Main is the whole program for either tool. prefix is the environment prefix
// (PAGEFORGE, INKBAR) and port the default port.
//
//	<bin>          serve
//	<bin> health   probe /healthz on the local port (the image's HEALTHCHECK:
//	               the runtime image has no curl)
func Main(tool Tool, prefix string, port int) int {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	listen := listenAddr(os.Getenv, port)
	if len(os.Args) > 1 && os.Args[1] == "health" {
		return health(listen)
	}
	opt, warnings := OptionsFromEnv(tool.Name, prefix, os.Getenv)
	opt.Log = log
	for _, w := range warnings {
		log.Warn(w, "tool", tool.Name)
	}
	srv := &http.Server{Addr: listen, Handler: New(tool, opt).Handler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second,
		IdleTimeout: 120 * time.Second, MaxHeaderBytes: 32 << 10}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Error("listen", "err", err)
		return 1
	}
	log.Info("listening", "tool", tool.Name, "addr", ln.Addr().String(), "signin", opt.OIDC != nil)
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shut)
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		return 1
	}
	return 0
}

func listenAddr(getenv func(string) string, port int) string {
	host := getenv("HOSTNAME")
	if host == "" {
		host = "127.0.0.1"
	}
	if p, err := strconv.Atoi(getenv("PORT")); err == nil && p >= 0 && p < 65536 {
		port = p
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// OptionsFromEnv reads <PREFIX>_*. What is missing switches sign-in off and is
// reported; it never makes the server start half-configured and pretend.
func OptionsFromEnv(name, prefix string, getenv func(string) string) (Options, []string) {
	var warnings []string
	opt := Options{SecureCookies: getenv(prefix+"_INSECURE_COOKIES") != "1", SessionTTL: 2 * time.Hour}
	if h, err := strconv.Atoi(strings.TrimSpace(getenv(prefix + "_SESSION_TTL_HOURS"))); err == nil && h > 0 && h <= 24 {
		opt.SessionTTL = time.Duration(h) * time.Hour
	}
	if raw := getenv(prefix + "_ACCOUNT_URL"); raw != "" {
		if opt.AccountURL = auth.ValidURL(raw, true); opt.AccountURL == "" {
			warnings = append(warnings, prefix+"_ACCOUNT_URL is not a valid https URL; the account link is hidden")
		}
	}
	cfg := auth.ConfigFromEnv(prefix, getenv)
	sealer, err := auth.NewSealer(getenv(prefix+"_SESSION_SECRET"), name)
	switch {
	case cfg == nil:
		warnings = append(warnings, "sign-in is off: "+prefix+"_OIDC_* is incomplete")
	case err != nil:
		warnings = append(warnings, fmt.Sprintf("sign-in is off: %s_SESSION_SECRET: %v", prefix, err))
	default:
		opt.OIDC, opt.Sealer = auth.NewClient(cfg), sealer
		if cfg.RequiredGroup == "" {
			warnings = append(warnings, prefix+"_OIDC_REQUIRED_GROUP is empty: the provider alone decides who gets in")
		}
	}
	return opt, warnings
}

func health(listen string) int {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	if host == "0.0.0.0" || host == "" || host == "::" {
		host = "127.0.0.1"
	}
	c := http.Client{Timeout: 3 * time.Second}
	res, err := c.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		return 1
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
