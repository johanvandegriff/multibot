package frontend

import (
	"crypto/sha256"
	"encoding/hex"
	"html/template"
	"log"
	"os"
)

var (
	IndexHTMLBytes = loadIndexHTML()
	// IndexTemplate *template.Template
	IndexPageHash = sha256sum(IndexHTMLBytes)
	IndexTemplate = template.Must(template.New("index.html").Parse(string(IndexHTMLBytes)))
)

func loadIndexHTML() []byte {
	IndexHTMLBytes, err := os.ReadFile("index.html")
	if err != nil {
		log.Println("Cannot read index.html:", err)
		return []byte(`<html><body><h1>tenant container fallback index</h1></body></html>`)
	}
	return IndexHTMLBytes
}

func sha256sum(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
