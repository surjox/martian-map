(function (root) {
  'use strict';

  const SIZE = 256;
  const HALF_EXTENT_KM = 59;
  const MARS_RADIUS_KM = 3389.5;
  const explorerTextureCache = new WeakMap();
  const MOLA_128_BASE = 'https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/';
  const REGIONS = Object.freeze([
    { id: 'jezero-perseverance', name: 'Jezero Crater · Perseverance landing region', latitude: 18.4447, longitude: 77.4508, product: 'MEGT44N000HB.IMG' },
    { id: 'gale-curiosity', name: 'Gale Crater · Curiosity landing region', latitude: -4.5895, longitude: 137.4417, product: 'MEGT00N090HB.IMG' },
    { id: 'gusev-spirit', name: 'Gusev Crater · Spirit landing region', latitude: -14.5684, longitude: 175.4726, product: 'MEGT00N090HB.IMG' },
    { id: 'meridiani-opportunity', name: 'Meridiani Planum · Opportunity landing region', latitude: -1.95, longitude: -5.53, product: 'MEGT00N270HB.IMG' },
    { id: 'elysium-insight', name: 'Elysium Planitia · InSight landing region', latitude: 4.5024, longitude: 135.6234, product: 'MEGT44N090HB.IMG' },
    { id: 'chryse-viking-1', name: 'Chryse Planitia · Viking 1 landing region', latitude: 22.48, longitude: -47.97, product: 'MEGT44N270HB.IMG' },
    { id: 'utopia-viking-2', name: 'Utopia Planitia · Viking 2 landing region', latitude: 47.64, longitude: -134.28, product: 'MEGT88N180HB.IMG' },
    { id: 'olympus-mons', name: 'Olympus Mons', latitude: 18.65, longitude: -133.8, product: 'MEGT44N180HB.IMG' },
    { id: 'valles-marineris', name: 'Valles Marineris', latitude: -8.5, longitude: -70, product: 'MEGT00N270HB.IMG' },
    { id: 'phoenix-landing', name: 'Vastitas Borealis · Phoenix landing region', latitude: 68.22, longitude: -125.75, product: 'MEGT88N180HB.IMG' }
  ].map(region => Object.freeze({
    ...region,
    file: `data/terrain-regions/${region.id}.bin`,
    source: `${MOLA_128_BASE}${region.product.toLowerCase()}`,
    sourceProduct: region.product,
    resolutionMeters: 463,
    patchSize: SIZE,
    halfExtentKm: HALF_EXTENT_KM
  })));

  function decodePatch(input) {
    const bytes = ArrayBuffer.isView(input)
      ? new DataView(input.buffer, input.byteOffset, input.byteLength)
      : new DataView(input);
    if (bytes.byteLength !== SIZE * SIZE * 2) {
      throw new RangeError(`Terrain patch must contain exactly ${SIZE * SIZE} signed 16-bit samples.`);
    }
    const elevations = new Int16Array(SIZE * SIZE);
    for (let index = 0; index < elevations.length; index++) {
      elevations[index] = bytes.getInt16(index * 2, false);
    }
    return { size: SIZE, elevations, halfExtentKm: HALF_EXTENT_KM, resolutionMeters: 463 };
  }

  function sampleRaster(patch, row, column) {
    const clampedRow = Math.max(0, Math.min(patch.size - 1, row));
    const clampedColumn = Math.max(0, Math.min(patch.size - 1, column));
    const row0 = Math.floor(clampedRow), column0 = Math.floor(clampedColumn);
    const row1 = Math.min(patch.size - 1, row0 + 1), column1 = Math.min(patch.size - 1, column0 + 1);
    const rowFraction = clampedRow - row0, columnFraction = clampedColumn - column0;
    const at = (r, c) => patch.elevations[r * patch.size + c];
    const top = at(row0, column0) * (1 - columnFraction) + at(row0, column1) * columnFraction;
    const bottom = at(row1, column0) * (1 - columnFraction) + at(row1, column1) * columnFraction;
    return top * (1 - rowFraction) + bottom * rowFraction;
  }

  function createGridPatch(grid, data, latitude, longitude, extentKm, size = SIZE) {
    if (!Number.isInteger(size) || size < 16 || size > 256) throw new RangeError('Terrain mesh size must be between 16 and 256 samples.');
    if (!Number.isFinite(extentKm) || extentKm < 1 || extentKm > 100) throw new RangeError('Terrain patch width must be between 1 and 100 km.');
    const center = data.validateCoordinate(latitude, longitude);
    const latitudeOffset = extentKm / (2 * MARS_RADIUS_KM) * 180 / Math.PI;
    if (Math.abs(center.latitude) + latitudeOffset >= 89.9) {
      throw new RangeError('A custom terrain patch must stay below 89.9° latitude.');
    }
    const elevations = new Int16Array(size * size);
    for (let row = 0; row < size; row++) {
      const northKm = (0.5 - row / (size - 1)) * extentKm;
      const sampleLatitude = center.latitude + northKm / MARS_RADIUS_KM * 180 / Math.PI;
      const cosine = Math.max(0.001, Math.cos(sampleLatitude * Math.PI / 180));
      for (let column = 0; column < size; column++) {
        const eastKm = (column / (size - 1) - 0.5) * extentKm;
        const sampleLongitude = center.longitude + eastKm / (MARS_RADIUS_KM * cosine) * 180 / Math.PI;
        const sample = data.sampleElevation(grid, sampleLatitude, sampleLongitude);
        elevations[row * size + column] = Math.max(-32768, Math.min(32767, Math.round(sample.elevationM)));
      }
    }
    return { size, elevations, halfExtentKm: extentKm / 2, resolutionMeters: data.MOLA_SOURCE.resolutionKmAtEquator * 1000 };
  }

  function colorAt(value, minimum, maximum) {
    const stops = [
      [0, [67, 47, 39]],
      [0.28, [126, 79, 54]],
      [0.55, [188, 126, 78]],
      [0.78, [219, 177, 126]],
      [1, [244, 222, 185]]
    ];
    const fraction = maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum);
    let index = 1;
    while (index < stops.length - 1 && fraction > stops[index][0]) index++;
    const [leftAt, left] = stops[index - 1], [rightAt, right] = stops[index];
    const mix = Math.max(0, Math.min(1, (fraction - leftAt) / (rightAt - leftAt)));
    return left.map((component, channel) => component + (right[channel] - component) * mix);
  }

  function buildMesh(patch, extentKm, exaggeration = 3, size = 128) {
    if (!patch || !(patch.elevations instanceof Int16Array) || patch.elevations.length !== patch.size * patch.size) {
      throw new TypeError('A decoded terrain patch is required.');
    }
    if (!Number.isFinite(extentKm) || extentKm <= 0 || extentKm > patch.halfExtentKm * 2) {
      throw new RangeError('Selected terrain width must fit inside the source patch.');
    }
    if (!Number.isFinite(exaggeration) || exaggeration < 1 || exaggeration > 8) {
      throw new RangeError('Vertical exaggeration must be between 1× and 8×.');
    }
    if (!Number.isInteger(size) || size < 16 || size > 256) throw new RangeError('Terrain mesh size must be between 16 and 256 samples.');
    let minimum = Infinity, maximum = -Infinity;
    const values = new Float32Array(size * size);
    const sourceWidth = (extentKm / (patch.halfExtentKm * 2)) * (patch.size - 1);
    const sourceStart = ((patch.size - 1) - sourceWidth) / 2;
    for (let row = 0; row < size; row++) {
      const sourceRow = sourceStart + row / (size - 1) * sourceWidth;
      for (let column = 0; column < size; column++) {
        const sourceColumn = sourceStart + column / (size - 1) * sourceWidth;
        const elevation = sampleRaster(patch, sourceRow, sourceColumn);
        values[row * size + column] = elevation;
        minimum = Math.min(minimum, elevation);
        maximum = Math.max(maximum, elevation);
      }
    }
    const vertices = new Float32Array(size * size * 6);
    const verticalScale = 2 * exaggeration / (extentKm * 1000);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const index = row * size + column, offset = index * 6;
        const elevation = values[index], color = colorAt(elevation, minimum, maximum);
        vertices[offset] = (column / (size - 1) - 0.5) * 2;
        vertices[offset + 1] = (0.5 - row / (size - 1)) * 2;
        vertices[offset + 2] = elevation * verticalScale;
        vertices[offset + 3] = color[0];
        vertices[offset + 4] = color[1];
        vertices[offset + 5] = color[2];
      }
    }
    const indices = new Uint32Array((size - 1) * (size - 1) * 6);
    let offset = 0;
    for (let row = 0; row < size - 1; row++) {
      for (let column = 0; column < size - 1; column++) {
        const topLeft = row * size + column, topRight = topLeft + 1;
        const bottomLeft = topLeft + size, bottomRight = bottomLeft + 1;
        indices[offset++] = topLeft; indices[offset++] = bottomLeft; indices[offset++] = topRight;
        indices[offset++] = topRight; indices[offset++] = bottomLeft; indices[offset++] = bottomRight;
      }
    }
    return { vertices, indices, size, minimumElevationM: minimum, maximumElevationM: maximum, extentKm, exaggeration };
  }

  function createExplorerTexture(patch, extentKm, size = patch?.size, textureSize = size * 2) {
    const mesh = buildMesh(patch, extentKm, 3, size);
    if (!Number.isInteger(textureSize) || textureSize < size || textureSize > 1024) {
      throw new RangeError('Terrain Explorer texture size must be between mesh size and 1024 pixels.');
    }
    let cached = explorerTextureCache.get(patch);
    const key = `${extentKm}:${size}:${textureSize}`;
    if (cached?.has(key)) return cached.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = textureSize;
    canvas.height = textureSize;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A 2D canvas is required to create the Terrain Explorer surface style.');

    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const a = mesh.indices[offset], b = mesh.indices[offset + 1], c = mesh.indices[offset + 2];
      const vertexOffset = a * 6;
      context.beginPath();
      context.moveTo(
        (mesh.vertices[vertexOffset] + 1) * 0.5 * textureSize,
        (1 - mesh.vertices[vertexOffset + 1]) * 0.5 * textureSize
      );
      for (const index of [b, c]) {
        const vertex = index * 6;
        context.lineTo(
          (mesh.vertices[vertex] + 1) * 0.5 * textureSize,
          (1 - mesh.vertices[vertex + 1]) * 0.5 * textureSize
        );
      }
      context.closePath();
      context.fillStyle = `rgb(${Math.round(mesh.vertices[vertexOffset + 3])},${Math.round(mesh.vertices[vertexOffset + 4])},${Math.round(mesh.vertices[vertexOffset + 5])})`;
      context.fill();
      context.strokeStyle = 'rgba(13, 15, 18, .16)';
      context.lineWidth = 0.35 * textureSize / size;
      context.stroke();
    }

    if (!cached) {
      cached = new Map();
      explorerTextureCache.set(patch, cached);
    }
    cached.set(key, canvas);
    return canvas;
  }

  function attachViewer(canvas) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A 2D canvas is required to display the terrain model.');
    const nav = root.MarsWalkNavigation || (typeof MarsWalkNavigation !== 'undefined' ? MarsWalkNavigation : null);
    let model = null;
    let previousTouchAction = null;
    const initialYaw = -0.6, initialPitch = -0.72, initialZoom = 1;
    let yaw = initialYaw, pitch = initialPitch, zoom = initialZoom;
    let targetYaw = initialYaw, targetPitch = initialPitch, targetZoom = initialZoom;
    let panX = 0, panY = 0;
    let targetPanX = 0, targetPanY = 0;
    let destroyed = false;
    let frame = null, lastFrameTime = null;
    const pointers = new Map();
    let pinchDistance = 0;
    const projected = [];
    const minPitch = -1.45, maxPitch = -0.08;
    const minZoom = 0.45, maxZoom = 3.5;

    function draw() {
      if (destroyed) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#080d13';
      context.fillRect(0, 0, width, height);
      if (!model) {
        context.fillStyle = '#c6cbd1';
        context.font = `${14 * dpr}px sans-serif`;
        context.textAlign = 'center';
        context.fillText('Choose a region, then load its 3D terrain model', width / 2, height / 2);
        return;
      }
      const cosineYaw = Math.cos(yaw), sineYaw = Math.sin(yaw);
      const cosinePitch = Math.cos(pitch), sinePitch = Math.sin(pitch);
      const distance = 3.7 / zoom, focal = Math.min(width, height) * 0.78;
      const centerX = width / 2 + panX * dpr, centerY = height * 0.53 + panY * dpr;
      const count = model.size * model.size;
      projected.length = count;
      for (let index = 0; index < count; index++) {
        const offset = index * 6, x = model.vertices[offset], y = model.vertices[offset + 1], z = model.vertices[offset + 2];
        const rotatedX = x * cosineYaw + z * sineYaw;
        const yawZ = -x * sineYaw + z * cosineYaw;
        const rotatedY = y * cosinePitch - yawZ * sinePitch;
        const depth = distance - (y * sinePitch + yawZ * cosinePitch);
        projected[index] = {
          x: centerX + rotatedX * focal / depth,
          y: centerY - rotatedY * focal / depth,
          depth,
          color: `rgb(${Math.round(model.vertices[offset + 3])},${Math.round(model.vertices[offset + 4])},${Math.round(model.vertices[offset + 5])})`
        };
      }
      const triangles = [];
      for (let index = 0; index < model.indices.length; index += 3) {
        const a = model.indices[index], b = model.indices[index + 1], c = model.indices[index + 2];
        triangles.push({ a, b, c, depth: (projected[a].depth + projected[b].depth + projected[c].depth) / 3 });
      }
      triangles.sort((a, b) => b.depth - a.depth);
      for (const triangle of triangles) {
        const a = projected[triangle.a], b = projected[triangle.b], c = projected[triangle.c];
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.lineTo(c.x, c.y);
        context.closePath();
        context.fillStyle = projected[triangle.a].color;
        context.fill();
        context.strokeStyle = 'rgba(13, 15, 18, .16)';
        context.lineWidth = 0.35 * dpr;
        context.stroke();
      }
      context.fillStyle = 'rgba(225, 231, 237, .82)';
      context.font = `${11 * dpr}px sans-serif`;
      context.textAlign = 'left';
      context.fillText(`Elevation ${Math.round(model.minimumElevationM).toLocaleString()} to ${Math.round(model.maximumElevationM).toLocaleString()} m`, 12 * dpr, height - 12 * dpr);
    }

    function scheduleAnimation() {
      if (frame !== null || destroyed) return;
      frame = window.requestAnimationFrame(stepAnimation);
    }

    function stepAnimation(now) {
      frame = null;
      if (destroyed) return;
      const elapsed = lastFrameTime === null ? 1 / 60 : Math.max(0, Math.min(0.1, (now - lastFrameTime) / 1000));
      lastFrameTime = now;
      const damping = 1 - Math.exp(-12 * elapsed);

      yaw += (targetYaw - yaw) * damping;
      pitch += (targetPitch - pitch) * damping;
      zoom += (targetZoom - zoom) * damping;
      panX += (targetPanX - panX) * damping;
      panY += (targetPanY - panY) * damping;

      if (Math.abs(yaw - targetYaw) < 1e-4) yaw = targetYaw;
      if (Math.abs(pitch - targetPitch) < 1e-4) pitch = targetPitch;
      if (Math.abs(zoom - targetZoom) < 1e-4) zoom = targetZoom;
      if (Math.abs(panX - targetPanX) < 0.1) panX = targetPanX;
      if (Math.abs(panY - targetPanY) < 0.1) panY = targetPanY;

      draw();

      if (yaw !== targetYaw || pitch !== targetPitch || zoom !== targetZoom ||
          panX !== targetPanX || panY !== targetPanY) {
        frame = window.requestAnimationFrame(stepAnimation);
      } else {
        lastFrameTime = null;
      }
    }

    function panBy(dx, dy) {
      targetPanX += dx;
      targetPanY += dy;
      scheduleAnimation();
    }

    function orbitBy(dx, dy) {
      // MarsWalk's orbit math reused with inverted deltas: the explorer's
      // camera convention mirrors MarsWalk's, so the same pointer movement
      // must be applied with the opposite sign to match its visual direction.
      const angles = nav && typeof nav.orbitAngles === 'function'
        ? nav.orbitAngles(targetYaw, targetPitch, -dx, dy)
        : null;
      targetYaw = angles ? angles.yaw : targetYaw + dx * 0.006;
      targetPitch = Math.max(minPitch, Math.min(maxPitch, targetPitch - dy * 0.006));
      scheduleAnimation();
    }

    function zoomByPixels(deltaPixels) {
      const logarithmicChange = Math.max(-0.25, Math.min(0.25, -deltaPixels * 0.0025));
      targetZoom = Math.max(minZoom, Math.min(maxZoom, targetZoom * Math.exp(logarithmicChange)));
      scheduleAnimation();
    }

    function scaleZoom(factor) {
      if (!Number.isFinite(factor) || factor <= 0) return;
      targetZoom = Math.max(minZoom, Math.min(maxZoom, targetZoom * factor));
      scheduleAnimation();
    }

    function pointerDistance() {
      const pts = [...pointers.values()];
      return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    function pointerCenter() {
      const pts = [...pointers.values()];
      return {
        x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
        y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length
      };
    }

    function pointerDown(event) {
      const touch = event.pointerType === 'touch';
      if (!touch && ![0, 1, 2].includes(event.button)) return;
      if (event.cancelable) event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        action: touch || (event.button === 0 && !event.shiftKey) ? 'orbit' : 'pan'
      });
      pinchDistance = pointers.size === 2 ? pointerDistance() : 0;
    }

    function pointerMove(event) {
      if (!pointers.has(event.pointerId)) return;
      if (event.cancelable) event.preventDefault();
      const pointer = pointers.get(event.pointerId);
      const prevCenter = pointers.size > 1 ? pointerCenter() : null;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (pointers.size >= 2) {
        const nextCenter = pointerCenter();
        panBy(nextCenter.x - prevCenter.x, nextCenter.y - prevCenter.y);
        const nextDist = pointerDistance();
        if (pinchDistance > 0 && nextDist > 0) {
          scaleZoom(nextDist / pinchDistance);
        }
        pinchDistance = nextDist;
      } else if (pointer.action === 'orbit') {
        orbitBy(dx, dy);
      } else {
        panBy(dx, dy);
      }
    }

    function pointerUp(event) {
      pointers.delete(event.pointerId);
      pinchDistance = pointers.size === 2 ? pointerDistance() : 0;
    }

    function wheel(event) {
      if (event.cancelable) event.preventDefault();
      const gesture = nav && typeof nav.classifyWheel === 'function'
        ? nav.classifyWheel(event, canvas.clientHeight)
        : (event.ctrlKey || event.metaKey
            ? { type: 'zoom', delta: event.deltaY }
            : (event.shiftKey
                ? { type: 'pan', deltaX: event.deltaY, deltaY: 0 }
                : (event.deltaX !== 0 || (event.deltaMode === 0 && Math.abs(event.deltaY) < 80)
                    ? { type: 'pan', deltaX: event.deltaX, deltaY: event.deltaY }
                    : { type: 'zoom', delta: event.deltaY })));
      if (gesture.type === 'zoom') zoomByPixels(gesture.delta);
      else panBy(gesture.deltaX, gesture.deltaY);
    }

    let gestureScale = 1;
    function gestureStart(event) {
      if (event.cancelable) event.preventDefault();
      gestureScale = Number.isFinite(event.scale) ? event.scale : 1;
    }
    function gestureChange(event) {
      if (!Number.isFinite(event.scale) || event.scale <= 0) return;
      if (event.cancelable) event.preventDefault();
      scaleZoom(event.scale / gestureScale);
      gestureScale = event.scale;
    }
    function gestureEnd() { gestureScale = 1; }
    function contextMenu(event) { event.preventDefault(); }

    function keyDown(event) {
      const rotations = { ArrowLeft: [-0.08, 0], ArrowRight: [0.08, 0], ArrowUp: [0, -0.08], ArrowDown: [0, 0.08] };
      if (rotations[event.key]) {
        event.preventDefault();
        if (event.shiftKey) {
          panBy(event.key === 'ArrowLeft' ? -15 : event.key === 'ArrowRight' ? 15 : 0,
                event.key === 'ArrowUp' ? -15 : event.key === 'ArrowDown' ? 15 : 0);
        } else {
          targetYaw += rotations[event.key][0];
          targetPitch = Math.max(minPitch, Math.min(maxPitch, targetPitch + rotations[event.key][1]));
          scheduleAnimation();
        }
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault(); scaleZoom(1.15);
      } else if (event.key === '-') {
        event.preventDefault(); scaleZoom(1 / 1.15);
      }
    }

    function resize() { scheduleAnimation(); }

    previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', pointerDown, { passive: false });
    canvas.addEventListener('pointermove', pointerMove, { passive: false });
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('gesturestart', gestureStart, { passive: false });
    canvas.addEventListener('gesturechange', gestureChange, { passive: false });
    canvas.addEventListener('gestureend', gestureEnd);
    canvas.addEventListener('contextmenu', contextMenu);
    canvas.addEventListener('keydown', keyDown);
    window.addEventListener('resize', resize);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    scheduleAnimation();

    return Object.freeze({
      setModel(value) { model = value; scheduleAnimation(); },
      reset() {
        targetYaw = initialYaw; targetPitch = initialPitch; targetZoom = initialZoom;
        targetPanX = 0; targetPanY = 0;
        scheduleAnimation();
      },
      destroy() {
        destroyed = true;
        if (frame !== null) window.cancelAnimationFrame(frame);
        observer?.disconnect();
        canvas.style.touchAction = previousTouchAction;
        canvas.removeEventListener('pointerdown', pointerDown);
        canvas.removeEventListener('pointermove', pointerMove);
        canvas.removeEventListener('pointerup', pointerUp);
        canvas.removeEventListener('pointercancel', pointerUp);
        canvas.removeEventListener('wheel', wheel);
        canvas.removeEventListener('gesturestart', gestureStart);
        canvas.removeEventListener('gesturechange', gestureChange);
        canvas.removeEventListener('gestureend', gestureEnd);
        canvas.removeEventListener('contextmenu', contextMenu);
        canvas.removeEventListener('keydown', keyDown);
        window.removeEventListener('resize', resize);
      }
    });
  }

  const api = Object.freeze({
    SIZE, HALF_EXTENT_KM, REGIONS, decodePatch, sampleRaster, createGridPatch, buildMesh,
    createExplorerTexture, attachViewer
  });
  root.MarsTerrainModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
