#!/bin/sh
# Enable hairpin mode on all br-lan bridge ports
# Required for Game UDP TPROXY (forwarded packets come back through same bridge)
for p in /sys/class/net/br-lan/brif/*; do
    [ -f "$p/hairpin_mode" ] && echo 1 > "$p/hairpin_mode"
done
