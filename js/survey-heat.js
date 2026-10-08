/* Survey density behind map labels. Canvas + OverlayView, no extra libraries. */
(function (root) {
  'use strict';
  const RADIUS = 64;
  const OPACITY = 0.35;
  const ramp = [[8,145,178], [234,179,8], [231,102,82]];
  const palette = Array.from({length:256}, (_, value) => {
    const part = value / 255 * (ramp.length - 1);
    const index = Math.min(ramp.length - 2, Math.floor(part));
    const fraction = part - index;
    return ramp[index].map((channel, i) => Math.round(channel + (ramp[index + 1][i] - channel) * fraction));
  });

  function create(map, points) {
    if (!root.google?.maps?.OverlayView) throw new Error('El mapa debe estar cargado para mostrar la densidad de encuestas.');
    // Copy the original label anchors. Clustering must never move the heat sources.
    const anchors = (Array.isArray(points) ? points : []).map(point => ({
      position:{lat:Number(point?.position?.lat),lng:Number(point?.position?.lng)},
      weight:Number(point?.weight)
    })).filter(point => Number.isFinite(point.position.lat) && Math.abs(point.position.lat) <= 90 &&
      Number.isFinite(point.position.lng) && Math.abs(point.position.lng) <= 180 && Number.isFinite(point.weight) && point.weight > 0);
    const maximum = anchors.reduce((value, point) => Math.max(value, point.weight), 0);
    const requestFrame = root.requestAnimationFrame ? callback => root.requestAnimationFrame(callback) : callback => root.setTimeout(callback, 16);
    const cancelFrame = root.cancelAnimationFrame ? id => root.cancelAnimationFrame(id) : id => root.clearTimeout(id);

    class SurveyHeatOverlay extends root.google.maps.OverlayView {
      constructor() {
        super();
        this.canvas = null;
        this.context = null;
        this.frame = null;
        this.resizeObserver = null;
        this.idleListener = null;
      }
      onAdd() {
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'mgpc-survey-heat';
        this.canvas.setAttribute('aria-hidden', 'true');
        Object.assign(this.canvas.style, {position:'absolute',pointerEvents:'none'});
        this.context = this.canvas.getContext('2d', {willReadFrequently:true});
        this.getPanes().overlayLayer.appendChild(this.canvas);
        const currentMap = this.getMap();
        this.idleListener = currentMap.addListener('idle', () => this.draw());
        if (root.ResizeObserver) {
          this.resizeObserver = new root.ResizeObserver(() => this.draw());
          this.resizeObserver.observe(currentMap.getDiv());
        }
      }
      draw() {
        if (!this.canvas || !this.context || this.frame !== null) return;
        this.frame = requestFrame(() => {
          this.frame = null;
          this.render();
        });
      }
      render() {
        const currentMap = this.getMap();
        const projection = this.getProjection();
        if (!this.canvas || !this.context || !currentMap || !projection) return;
        const container = currentMap.getDiv();
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (!width || !height) {
          this.canvas.width = this.canvas.height = 0;
          return;
        }
        // Container pixels and overlay pixels have different origins while panning.
        const corner = projection.fromContainerPixelToLatLng(new root.google.maps.Point(0, 0), true);
        const origin = corner && projection.fromLatLngToDivPixel(corner);
        if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;
        const left = origin.x - RADIUS;
        const top = origin.y - RADIUS;
        const cssWidth = width + RADIUS * 2;
        const cssHeight = height + RADIUS * 2;
        const ratio = Math.max(1, Math.min(2, Number(root.devicePixelRatio) || 1));
        const pixelWidth = Math.ceil(cssWidth * ratio);
        const pixelHeight = Math.ceil(cssHeight * ratio);
        Object.assign(this.canvas.style, {left:left+'px',top:top+'px',width:cssWidth+'px',height:cssHeight+'px'});
        if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
        if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
        const context = this.context;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, cssWidth, cssHeight);
        context.globalCompositeOperation = 'source-over';
        let visible = 0;
        for (const point of anchors) {
          const pixel = projection.fromLatLngToDivPixel(new root.google.maps.LatLng(point.position.lat, point.position.lng));
          if (!pixel || !Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) continue;
          const x = pixel.x - left;
          const y = pixel.y - top;
          if (x < -RADIUS || y < -RADIUS || x > cssWidth + RADIUS || y > cssHeight + RADIUS) continue;
          const gradient = context.createRadialGradient(x, y, 0, x, y, RADIUS);
          gradient.addColorStop(0, 'rgba(0,0,0,1)');
          gradient.addColorStop(0.25, 'rgba(0,0,0,0.75)');
          gradient.addColorStop(1, 'rgba(0,0,0,0)');
          context.fillStyle = gradient;
          context.globalAlpha = point.weight / maximum;
          context.fillRect(x - RADIUS, y - RADIUS, RADIUS * 2, RADIUS * 2);
          visible++;
        }
        context.globalAlpha = 1;
        if (!visible) return;
        // Color accumulated density only once, capping opacity even where halos overlap.
        const pixels = context.getImageData(0, 0, pixelWidth, pixelHeight);
        const data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
          const density = data[i + 3];
          if (!density) continue;
          const color = palette[density];
          data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2];
          data[i + 3] = Math.round(density * OPACITY);
        }
        context.putImageData(pixels, 0, 0);
      }
      onRemove() {
        if (this.frame !== null) cancelFrame(this.frame);
        this.frame = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.idleListener?.remove();
        this.idleListener = null;
        if (this.canvas) {
          this.canvas.remove();
          this.canvas.width = this.canvas.height = 0;
        }
        this.canvas = null;
        this.context = null;
      }
    }
    const overlay = new SurveyHeatOverlay();
    overlay.setMap(map || null);
    return Object.freeze({setMap:nextMap => overlay.setMap(nextMap || null),remove:() => overlay.setMap(null)});
  }
  root.MGPCSurveyHeat = Object.freeze({create});
})(window);
