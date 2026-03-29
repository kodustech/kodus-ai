#!/bin/bash
set -euo pipefail

# Resolve the Shadowsocks server hostname from config.json to get current NLB IPs.
# This must run BEFORE iptables redirect is active (otherwise DNS itself gets redirected).
SS_HOST=$(grep -oP '"server"\s*:\s*"\K[^"]+' config.json)
NLB_IPS=$(getent ahosts "$SS_HOST" 2>/dev/null | awk '{print $1}' | grep -v ':' | sort -u)

if [ -z "$NLB_IPS" ]; then
    echo "FATAL: Could not resolve NLB IPs for $SS_HOST" >&2
    exit 1
fi

# Create the chain if it doesn't exist, then flush it to ensure it's clean.
iptables -t nat -N SHADOWSOCKS 2>/dev/null || iptables -t nat -F SHADOWSOCKS

# Exclude NLB IPs from redirect (prevents sslocal → sslocal loop)
for ip in $NLB_IPS; do
    echo "iptables RETURN for NLB IP: $ip"
    iptables -t nat -A SHADOWSOCKS -d "$ip" -j RETURN
done

# Exclude private/reserved ranges
iptables -t nat -A SHADOWSOCKS -d 0.0.0.0/8 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 10.0.0.0/8 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 127.0.0.0/8 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 169.254.0.0/16 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 172.16.0.0/12 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 192.168.0.0/16 -j RETURN

# Redirect all other outbound TCP to sslocal
iptables -t nat -A SHADOWSOCKS -p tcp -j REDIRECT --to-ports 12345
# Add the jump from OUTPUT only if it doesn't already exist
iptables -t nat -C OUTPUT -p tcp -j SHADOWSOCKS 2>/dev/null || iptables -t nat -A OUTPUT -p tcp -j SHADOWSOCKS
