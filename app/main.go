package main

import (
  "embed"
  "log"

  "github.com/wailsapp/wails/v2"
  "github.com/wailsapp/wails/v2/pkg/options"
  "github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
  if err := wails.Run(&options.App{
    Title: "Agentic Engineering",
    Width: 1200, Height: 850, MinWidth: 760, MinHeight: 540,
    AssetServer: &assetserver.Options{Assets: assets},
    BackgroundColour: &options.RGBA{R:23,G:24,B:26,A:255},
  }); err != nil { log.Fatal(err) }
}
