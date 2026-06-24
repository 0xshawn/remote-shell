package main

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
)

// embeddedWeb carries the static frontend so a release binary is self-contained
// (no sibling web/ dir to copy). Normal builds embed only web/.gitkeep; the
// release build (.github/workflows/release.yml) stages the real web/ into
// server/web/ first. `all:` so dotfiles like .gitkeep are matched.
//
//go:embed all:web
var embeddedWeb embed.FS

// webHandler chooses where to serve the frontend from: the on-disk WEB_DIR when
// it exists (dev `WEB_DIR=web`, the container's `/web`, or an explicit override),
// otherwise the embedded copy. This keeps the dev/container builds serving from
// disk while a downloaded binary serves itself with no extra files.
func webHandler(cfg *config) http.Handler {
	if cfg.webDir != "" {
		if fi, err := os.Stat(cfg.webDir); err == nil && fi.IsDir() {
			return http.FileServer(http.Dir(cfg.webDir))
		}
	}
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		// Unreachable: "web" is always present (at least .gitkeep).
		logger.Errorf("embedded web fs: %v", err)
		return http.NotFoundHandler()
	}
	return http.FileServer(http.FS(sub))
}
