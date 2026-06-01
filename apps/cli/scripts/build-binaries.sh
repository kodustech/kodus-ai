#!/bin/bash
# Gera binários standalone (não precisa de Node.js instalado)

yarn global add pkg

# Build para todas plataformas
pkg . \
  --targets node18-linux-x64,node18-macos-x64,node18-win-x64 \
  --output dist/kodus

echo "✅ Binários criados em dist/"
echo "  - dist/kodus-linux"
echo "  - dist/kodus-macos"  
echo "  - dist/kodus-win.exe"
