# Thread Network Visualizer - minimal static web image
# Final image: ~1.5 MB (busybox:musl)
FROM busybox:musl

WORKDIR /www

# Static assets
COPY index.html app.js style.css ./

# Seed a default device_names.json inside the image.
# At runtime, entrypoint.sh promotes /config/device_names.json
# (mounted volume) over this default so user edits persist.
COPY device_names.json ./device_names.json.default

COPY httpd.conf /etc/httpd.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
VOLUME ["/config"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
