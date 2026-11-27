package main

import (
  "context"
  "embed"
  "log"

  "github.com/wailsapp/wails/v2"
  "github.com/wailsapp/wails/v2/pkg/options"
  "github.com/wailsapp/wails/v2/pkg/options/assetserver"
  "github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
  console := &HarnessConsole{}
  if err := wails.Run(&options.App{
    Title: "Agentic Engineering",
    Bind: []interface{}{&AgentConnection{}, console},
    OnShutdown: func(context.Context){console.stopAll()},
    Width: 1200, Height: 850, MinWidth: 760, MinHeight: 540,
    AssetServer: &assetserver.Options{Assets: assets},
    BackgroundColour: &options.RGBA{R:17,G:17,B:19,A:255},
    Mac: &mac.Options{TitleBar: mac.TitleBarHidden()},
  }); err != nil { log.Fatal(err) }
}
