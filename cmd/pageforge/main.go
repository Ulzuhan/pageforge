// PageForge: PDF tools that run in your browser. The server only serves the
// interface and the sign-in gate; files never reach it.
package main

import (
	"os"

	"github.com/Ulzuhan/pageforge/internal/server"
	"github.com/Ulzuhan/pageforge/internal/web/pageforge"
)

func main() {
	os.Exit(server.Main(server.Tool{Name: "pageforge", Title: "PageForge", Dist: pageforge.Dist()}, "PAGEFORGE", 3468))
}
