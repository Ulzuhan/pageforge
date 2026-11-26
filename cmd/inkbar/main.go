// InkBar: true PDF redaction in your browser. The server only serves the
// interface and the sign-in gate; files never reach it.
package main

import (
	"os"

	"github.com/Ulzuhan/pageforge/internal/server"
	"github.com/Ulzuhan/pageforge/internal/web/inkbar"
)

func main() {
	os.Exit(server.Main(server.Tool{Name: "inkbar", Title: "InkBar", Dist: inkbar.Dist()}, "INKBAR", 3469))
}
