#!/bin/bash
set -e
export PATH="/home/admin/.npm-global/bin:/home/admin/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd /opt/termigo
sudo env "PATH=$PATH" ./scripts/deploy-termigo.sh --build
