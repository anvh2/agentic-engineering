package main

import (
	"context"
	"embed"
	"log"
	"log/slog"
	"os"

	"github.com/go-logr/logr"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	logger := logr.FromSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	console := &HarnessConsole{}
	issueRuntime := newIssueRuntime(logger)
	if err := wails.Run(&options.App{
		Title: "Agentic Engineering",
		Bind:  []interface{}{&AgentConnection{}, &KnowledgeSource{}, console, issueRuntime},
		OnStartup: func(ctx context.Context) {
			console.ctx = ctx
			issueRuntime.start(ctx)
		},
		OnShutdown: func(ctx context.Context) {
			console.stopAll()
			issueRuntime.stop(ctx)
		},
		Width: 1200, Height: 850, MinWidth: 760, MinHeight: 540,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 17, G: 17, B: 19, A: 255},
		Mac:              &mac.Options{TitleBar: mac.TitleBarHidden()},
	}); err != nil {
		log.Fatal(err)
	}
}
