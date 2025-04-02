#!/bin/bash
set -e

# Log redirecionado para arquivos em local acessível
LOG_FILE="/var/lib/postgresql/data/pgvector_install.log"
exec > >(tee -a $LOG_FILE) 2>&1

echo "$(date): Iniciando instalação do pgvector"

# Instala dependências necessárias
echo "$(date): Instalando dependências..."
apt-get update
apt-get install -y git build-essential postgresql-server-dev-17

# Clona e instala pgvector
echo "$(date): Clonando repositório pgvector..."
cd /tmp
git clone --branch v0.5.1 https://github.com/pgvector/pgvector.git
cd pgvector

echo "$(date): Compilando pgvector..."
make
echo "$(date): Instalando pgvector..."
make install

# Verifica se a instalação foi bem-sucedida
echo "$(date): Verificando instalação..."
if [ -f "/usr/share/postgresql/17/extension/vector.control" ]; then
  echo "$(date): Instalação bem-sucedida! Arquivo vector.control encontrado."
else
  echo "$(date): ERRO! Arquivo vector.control não encontrado. Verificando diretório de extensões..."
  find /usr -name "extension" | grep postgresql
fi

# Limpa
echo "$(date): Limpando arquivos temporários..."
apt-get clean
rm -rf /tmp/pgvector

echo "$(date): Processo de instalação concluído"