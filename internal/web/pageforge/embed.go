// Package pageforge embeds the PageForge interface built by Vite (npm run build).
// dist/ is generated and never committed; the binary refuses to start without it.
package pageforge

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist is the build: index.html (public landing) and app/index.html (the tool).
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
