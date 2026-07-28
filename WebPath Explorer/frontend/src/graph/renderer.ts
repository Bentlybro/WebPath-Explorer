import {
  Compute,
  ComputePlugin,
  type ComputeNode,
  type ExecutionContext,
} from "@dylanebert/shallot/src/standard/compute/index.ts";
import { ViewportPlugin } from "@dylanebert/shallot/src/standard/viewport/index.ts";
import {
  NoLoading,
  run,
  type Config,
} from "@dylanebert/shallot/src/engine/app/index.ts";
import type { Plugin, State } from "@dylanebert/shallot/src/engine/ecs/index.ts";
import type { GraphBounds } from "./model";
import { GraphModel } from "./model";

const CAMERA_WGSL = /* wgsl */ `
struct Camera {
  viewport: vec2<f32>,
  center2d: vec2<f32>,
  params: vec4<f32>, // zoom, node scale, edge alpha, 3D mode
  targetDistance: vec4<f32>, // orbit target xyz, distance
  orbit: vec4<f32>, // yaw, pitch, field of view, time
}

struct Projection {
  clip: vec4<f32>,
  scale: f32,
  visible: f32,
}

fn project(world: vec3<f32>) -> Projection {
  if (camera.params.w < 0.5) {
    let screen = (world.xy - camera.center2d) * camera.params.x + camera.viewport * 0.5;
    let clip = vec2(
      screen.x / camera.viewport.x * 2.0 - 1.0,
      1.0 - screen.y / camera.viewport.y * 2.0
    );
    return Projection(vec4(clip, 0.15, 1.0), 1.0, 1.0);
  }

  let orbitTarget = camera.targetDistance.xyz;
  let distance = camera.targetDistance.w;
  let yaw = camera.orbit.x;
  let pitch = camera.orbit.y;
  let cosPitch = cos(pitch);
  let cameraOffset = vec3(
    sin(yaw) * cosPitch,
    sin(pitch),
    cos(yaw) * cosPitch
  ) * distance;
  let cameraPosition = orbitTarget + cameraOffset;
  let forward = normalize(orbitTarget - cameraPosition);
  let right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let relative = world - cameraPosition;
  let viewX = dot(relative, right);
  let viewY = dot(relative, up);
  let viewZ = dot(relative, forward);
  if (viewZ <= 1.0) {
    return Projection(vec4(-4.0, -4.0, 1.0, 1.0), 0.0, 0.0);
  }
  let tanHalfFov = tan(camera.orbit.z * 0.5);
  let aspect = camera.viewport.x / max(1.0, camera.viewport.y);
  let clip = vec2(
    viewX / (viewZ * tanHalfFov * aspect),
    viewY / (viewZ * tanHalfFov)
  );
  let farPlane = max(10000.0, distance * 8.0);
  let depth = clamp(viewZ / farPlane, 0.0001, 0.9999);
  let perspectiveScale = clamp(distance / viewZ, 0.22, 3.2);
  let visible = select(0.0, 1.0, abs(clip.x) < 1.3 && abs(clip.y) < 1.3);
  return Projection(vec4(clip, depth, 1.0), perspectiveScale, visible);
}
`;

const NODE_SHADER = /* wgsl */ `
${CAMERA_WGSL}

@group(0) @binding(0) var<storage, read> positions: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> positions3d: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> colors: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> nodeData: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> camera: Camera;

var<private> corners: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
  vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
);

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) flags: vec2<f32>,
  @location(3) depthShade: f32,
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let data = nodeData[instance];
  let world = select(
    vec3(positions[instance], 0.0),
    positions3d[instance].xyz,
    camera.params.w > 0.5
  );
  let projected = project(world);
  let corner = corners[vertexIndex];
  let zoomScale = select(
    clamp(pow(camera.params.x, 0.16), 0.72, 2.15),
    projected.scale,
    camera.params.w > 0.5
  );
  let radius = data.x * camera.params.y * zoomScale + max(data.z, data.w) * 2.5;
  let pixelOffset = corner * radius;
  var clip = projected.clip;
  let clipOffset = vec2(
    pixelOffset.x / camera.viewport.x * 2.0,
    -pixelOffset.y / camera.viewport.y * 2.0
  );
  clip = vec4(clip.xy + clipOffset, clip.z, clip.w);
  clip.z = max(0.0, clip.z - 0.00008);
  if (data.y < 0.5 || projected.visible < 0.5) {
    clip = vec4(-4.0, -4.0, 1.0, 1.0);
  }

  var output: VertexOutput;
  output.position = clip;
  output.local = corner;
  output.color = colors[instance];
  output.flags = data.zw;
  output.depthShade = select(1.0, clamp(0.55 + projected.scale * 0.38, 0.5, 1.25), camera.params.w > 0.5);
  return output;
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.local);
  let edge = 1.0 - smoothstep(0.86, 1.0, distance);
  if (edge <= 0.002) { discard; }
  let selected = input.flags.x;
  let original = input.flags.y;
  let ringStart = select(0.78, 0.56, selected > 0.5);
  let ring = smoothstep(ringStart, ringStart + 0.08, distance);
  var color = input.color.rgb * input.depthShade;
  color = mix(color, vec3(1.0, 0.69, 0.18), original * ring * 0.94);
  color = mix(color, vec3(0.91, 1.0, 0.95), selected * ring);
  color += (1.0 - smoothstep(0.0, 0.72, distance)) * 0.18;
  let alpha = edge * mix(0.88, 1.0, max(selected, original));
  return vec4(color * alpha, alpha);
}
`;

const EDGE_SHADER = /* wgsl */ `
${CAMERA_WGSL}

@group(0) @binding(0) var<storage, read> positions: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> positions3d: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> colors: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> nodeData: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> edges: array<vec2<u32>>;
@group(0) @binding(5) var<uniform> camera: Camera;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let edge = edges[instance];
  let nodeIndex = select(edge.x, edge.y, vertexIndex == 1u);
  let otherIndex = select(edge.y, edge.x, vertexIndex == 1u);
  let data = nodeData[nodeIndex];
  let otherData = nodeData[otherIndex];
  let world = select(
    vec3(positions[nodeIndex], 0.0),
    positions3d[nodeIndex].xyz,
    camera.params.w > 0.5
  );
  let otherWorld = select(
    vec3(positions[otherIndex], 0.0),
    positions3d[otherIndex].xyz,
    camera.params.w > 0.5
  );
  let projected = project(world);
  let otherProjected = project(otherWorld);
  var clip = projected.clip;
  if (camera.params.w < 0.5) { clip.z = 0.65; }
  if (data.y < 0.5 || otherData.y < 0.5 || projected.scale <= 0.0 || otherProjected.scale <= 0.0) {
    clip = vec4(-4.0, -4.0, 1.0, 1.0);
  }
  let isActive = max(data.z, otherData.z);
  let tint = mix(colors[nodeIndex].rgb, vec3(0.72, 0.92, 0.86), 0.34 + isActive * 0.55);
  let depthShade = select(1.0, clamp(0.48 + projected.scale * 0.35, 0.35, 1.1), camera.params.w > 0.5);
  var output: VertexOutput;
  output.position = clip;
  output.color = vec4(tint * depthShade, camera.params.z * (1.0 + isActive * 2.4));
  return output;
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4(input.color.rgb * input.color.a, input.color.a);
}
`;

function bufferSize(bytes: number): number {
  return Math.max(16, Math.ceil(bytes / 16) * 16);
}

function createStorage(device: GPUDevice, label: string, bytes: number): GPUBuffer {
  return device.createBuffer({
    label,
    size: bufferSize(bytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

async function assertShaderValid(module: GPUShaderModule, label: string): Promise<void> {
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === "error");
  if (!errors.length) return;
  const details = errors
    .map(
      (message) =>
        `${label}:${message.lineNum}:${message.linePos} ${message.message}`,
    )
    .join("\n");
  throw new Error(details);
}

export type ViewMode = "2d" | "3d";

export interface CameraState {
  centerX: number;
  centerY: number;
  zoom: number;
  nodeScale: number;
  edgeAlpha: number;
  mode: ViewMode;
  targetX: number;
  targetY: number;
  targetZ: number;
  distance: number;
  yaw: number;
  pitch: number;
  fov: number;
}

export interface ProjectedNode {
  x: number;
  y: number;
  viewDepth: number;
  radius: number;
  visible: boolean;
}

export interface RenderSnapshot {
  nodeCount: number;
  edgeCount: number;
  gpuBytes: number;
}

export class ShallotGraphRenderer {
  readonly camera: CameraState = {
    centerX: 0,
    centerY: 0,
    zoom: 1,
    nodeScale: 1,
    edgeAlpha: 0.13,
    mode: "2d",
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    distance: 2000,
    yaw: -0.68,
    pitch: -0.42,
    fov: Math.PI / 3,
  };

  private device: GPUDevice | null = null;
  private model: GraphModel | null = null;
  private positions: GPUBuffer | null = null;
  private positions3D: GPUBuffer | null = null;
  private colors: GPUBuffer | null = null;
  private meta: GPUBuffer | null = null;
  private edges: GPUBuffer | null = null;
  private uniform: GPUBuffer | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthWidth = 0;
  private depthHeight = 0;
  private nodePipeline: GPURenderPipeline | null = null;
  private edgePipeline: GPURenderPipeline | null = null;
  private nodeBindGroup: GPUBindGroup | null = null;
  private edgeBindGroup: GPUBindGroup | null = null;
  private bufferGeneration = 0;
  private bindGeneration = -1;
  private readonly uniformData = new Float32Array(20);

  readonly plugin: Plugin = {
    name: "WebPath graph renderer",
    dependencies: [ComputePlugin, ViewportPlugin],
    initialize: (state: State) => {
      const compute = Compute.from(state);
      if (!compute) throw new Error("Shallot ComputePlugin was not initialized");
      this.device = compute.device;
      this.ensureBuffers();
      if (this.model) this.uploadModel(this.model);
      compute.graph.add(this.createDrawNode());
      state.onDispose(() => this.disposeGpu());
    },
  };

  is3D(): boolean {
    return this.camera.mode === "3d";
  }

  setViewMode(mode: ViewMode): void {
    this.camera.mode = mode;
  }

  setModel(model: GraphModel): void {
    this.model = model;
    if (this.device) this.uploadModel(model);
  }

  updateMeta(): void {
    if (!this.device || !this.model || !this.meta) return;
    this.device.queue.writeBuffer(this.meta, 0, this.model.meta as Float32Array<ArrayBuffer>);
  }

  fit(bounds: GraphBounds, viewportWidth: number, viewportHeight: number, padding = 120): void {
    if (this.is3D()) {
      const volume = bounds.volume;
      const halfX = Math.max(1, (volume.maxX - volume.minX) * 0.5);
      const halfY = Math.max(1, (volume.maxY - volume.minY) * 0.5);
      const halfZ = Math.max(1, (volume.maxZ - volume.minZ) * 0.5);
      const aspect = Math.max(0.2, viewportWidth / Math.max(1, viewportHeight));
      const radius = Math.hypot(halfX, halfY, halfZ);
      const verticalHalfFov = this.camera.fov * 0.5;
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
      const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
      this.camera.targetX = (volume.minX + volume.maxX) * 0.5;
      this.camera.targetY = (volume.minY + volume.maxY) * 0.5;
      this.camera.targetZ = (volume.minZ + volume.maxZ) * 0.5;
      this.camera.distance = Math.max(80, (radius / Math.sin(limitingHalfFov)) * 1.12);
      return;
    }
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    this.camera.centerX = (bounds.minX + bounds.maxX) * 0.5;
    this.camera.centerY = (bounds.minY + bounds.maxY) * 0.5;
    this.camera.zoom = Math.max(
      0.002,
      Math.min(12, Math.min((viewportWidth - padding) / width, (viewportHeight - padding) / height)),
    );
  }

  reset3DOrientation(): void {
    this.camera.yaw = -0.68;
    this.camera.pitch = -0.42;
  }

  focusNode(index: number, targetZoom = 1.5): void {
    if (!this.model || index < 0 || index >= this.model.nodes.length) return;
    if (this.is3D()) {
      const offset = index * 4;
      this.camera.targetX = this.model.positions3D[offset]!;
      this.camera.targetY = this.model.positions3D[offset + 1]!;
      this.camera.targetZ = this.model.positions3D[offset + 2]!;
      this.camera.distance = Math.max(60, Math.min(this.camera.distance * 0.45, 900));
      return;
    }
    this.camera.centerX = this.model.positions[index * 2]!;
    this.camera.centerY = this.model.positions[index * 2 + 1]!;
    this.camera.zoom = Math.max(this.camera.zoom, targetZoom);
  }

  screenToWorld(
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
  ): [number, number] {
    return [
      (x - viewportWidth * 0.5) / this.camera.zoom + this.camera.centerX,
      (y - viewportHeight * 0.5) / this.camera.zoom + this.camera.centerY,
    ];
  }

  zoomAt(
    screenX: number,
    screenY: number,
    multiplier: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    if (this.is3D()) {
      this.camera.distance = Math.max(20, Math.min(2_000_000, this.camera.distance / multiplier));
      return;
    }
    const before = this.screenToWorld(screenX, screenY, viewportWidth, viewportHeight);
    this.camera.zoom = Math.min(64, Math.max(0.001, this.camera.zoom * multiplier));
    const after = this.screenToWorld(screenX, screenY, viewportWidth, viewportHeight);
    this.camera.centerX += before[0] - after[0];
    this.camera.centerY += before[1] - after[1];
  }

  panBy(screenDeltaX: number, screenDeltaY: number): void {
    this.camera.centerX -= screenDeltaX / this.camera.zoom;
    this.camera.centerY -= screenDeltaY / this.camera.zoom;
  }

  orbitBy(screenDeltaX: number, screenDeltaY: number): void {
    this.camera.yaw -= screenDeltaX * 0.006;
    this.camera.pitch = Math.max(
      -Math.PI * 0.48,
      Math.min(Math.PI * 0.48, this.camera.pitch + screenDeltaY * 0.006),
    );
  }

  pan3DBy(screenDeltaX: number, screenDeltaY: number, viewportHeight: number): void {
    const basis = this.cameraBasis();
    const unitsPerPixel =
      (2 * this.camera.distance * Math.tan(this.camera.fov * 0.5)) / Math.max(1, viewportHeight);
    const horizontal = -screenDeltaX * unitsPerPixel;
    const vertical = screenDeltaY * unitsPerPixel;
    this.camera.targetX += basis.right[0] * horizontal + basis.up[0] * vertical;
    this.camera.targetY += basis.right[1] * horizontal + basis.up[1] * vertical;
    this.camera.targetZ += basis.right[2] * horizontal + basis.up[2] * vertical;
  }

  projectNode(index: number, viewportWidth: number, viewportHeight: number): ProjectedNode | null {
    if (!this.model || index < 0 || index >= this.model.nodes.length) return null;
    const position2DOffset = index * 2;
    const position3DOffset = index * 4;
    const x = this.is3D()
      ? this.model.positions3D[position3DOffset]!
      : this.model.positions[position2DOffset]!;
    const y = this.is3D()
      ? this.model.positions3D[position3DOffset + 1]!
      : this.model.positions[position2DOffset + 1]!;
    const z = this.is3D() ? this.model.positions3D[position3DOffset + 2]! : 0;
    const baseRadius = this.model.meta[index * 4] ?? 0;
    const selected = this.model.meta[index * 4 + 2] ?? 0;
    const original = this.model.meta[index * 4 + 3] ?? 0;
    if (!this.is3D()) {
      return {
        x: (x - this.camera.centerX) * this.camera.zoom + viewportWidth * 0.5,
        y: (y - this.camera.centerY) * this.camera.zoom + viewportHeight * 0.5,
        viewDepth: 0,
        radius: this.nodeScreenRadius(index),
        visible: true,
      };
    }
    const basis = this.cameraBasis();
    const relative: [number, number, number] = [
      x - basis.position[0],
      y - basis.position[1],
      z - basis.position[2],
    ];
    const viewX = dot(relative, basis.right);
    const viewY = dot(relative, basis.up);
    const viewDepth = dot(relative, basis.forward);
    if (viewDepth <= 1) return null;
    const tanHalf = Math.tan(this.camera.fov * 0.5);
    const aspect = viewportWidth / Math.max(1, viewportHeight);
    const clipX = viewX / (viewDepth * tanHalf * aspect);
    const clipY = viewY / (viewDepth * tanHalf);
    const scale = Math.max(0.22, Math.min(3.2, this.camera.distance / viewDepth));
    return {
      x: (clipX * 0.5 + 0.5) * viewportWidth,
      y: (0.5 - clipY * 0.5) * viewportHeight,
      viewDepth,
      radius:
        baseRadius * this.camera.nodeScale * scale + Math.max(selected, original) * 2.5,
      visible: Math.abs(clipX) < 1.3 && Math.abs(clipY) < 1.3,
    };
  }

  pickNode(screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): number {
    if (!this.model) return -1;
    let closest = -1;
    let closestDepth = Infinity;
    for (let index = 0; index < this.model.nodes.length; index++) {
      if ((this.model.meta[index * 4 + 1] ?? 0) < 0.5) continue;
      const projected = this.projectNode(index, viewportWidth, viewportHeight);
      if (!projected?.visible) continue;
      const dx = projected.x - screenX;
      const dy = projected.y - screenY;
      const hitRadius = Math.max(5, projected.radius);
      if (dx * dx + dy * dy <= hitRadius * hitRadius && projected.viewDepth < closestDepth) {
        closest = index;
        closestDepth = projected.viewDepth;
      }
    }
    return closest;
  }

  nodeScreenRadius(index: number): number {
    if (!this.model || index < 0 || index >= this.model.nodes.length) return 0;
    const offset = index * 4;
    const baseRadius = this.model.meta[offset] ?? 0;
    const selected = this.model.meta[offset + 2] ?? 0;
    const original = this.model.meta[offset + 3] ?? 0;
    const zoomScale = Math.min(2.15, Math.max(0.72, this.camera.zoom ** 0.16));
    return baseRadius * this.camera.nodeScale * zoomScale + Math.max(selected, original) * 2.5;
  }

  snapshot(): RenderSnapshot {
    const gpuBytes =
      (this.positions?.size ?? 0) +
      (this.positions3D?.size ?? 0) +
      (this.colors?.size ?? 0) +
      (this.meta?.size ?? 0) +
      (this.edges?.size ?? 0) +
      (this.uniform?.size ?? 0);
    return {
      nodeCount: this.model?.nodes.length ?? 0,
      edgeCount: (this.model?.edgeIndices.length ?? 0) / 2,
      gpuBytes,
    };
  }

  private cameraBasis(): {
    position: [number, number, number];
    forward: [number, number, number];
    right: [number, number, number];
    up: [number, number, number];
  } {
    const cosPitch = Math.cos(this.camera.pitch);
    const position: [number, number, number] = [
      this.camera.targetX + Math.sin(this.camera.yaw) * cosPitch * this.camera.distance,
      this.camera.targetY + Math.sin(this.camera.pitch) * this.camera.distance,
      this.camera.targetZ + Math.cos(this.camera.yaw) * cosPitch * this.camera.distance,
    ];
    const forward = normalize([
      this.camera.targetX - position[0],
      this.camera.targetY - position[1],
      this.camera.targetZ - position[2],
    ]);
    const right = normalize(cross(forward, [0, 1, 0]));
    return { position, forward, right, up: cross(right, forward) };
  }

  private ensureBuffers(): void {
    if (!this.device) return;
    this.positions ??= createStorage(this.device, "webpath/node-positions", 16);
    this.positions3D ??= createStorage(this.device, "webpath/node-positions-3d", 16);
    this.colors ??= createStorage(this.device, "webpath/node-colors", 16);
    this.meta ??= createStorage(this.device, "webpath/node-meta", 16);
    this.edges ??= createStorage(this.device, "webpath/edges", 16);
    this.uniform ??= this.device.createBuffer({
      label: "webpath/camera",
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private replaceBuffer(current: GPUBuffer | null, label: string, bytes: number): GPUBuffer {
    if (!this.device) throw new Error("Renderer device is unavailable");
    if (current && current.size >= bufferSize(bytes)) return current;
    current?.destroy();
    this.bufferGeneration++;
    return createStorage(this.device, label, bytes);
  }

  private uploadModel(model: GraphModel): void {
    if (!this.device) return;
    this.ensureBuffers();
    this.positions = this.replaceBuffer(this.positions, "webpath/node-positions", model.positions.byteLength);
    this.positions3D = this.replaceBuffer(
      this.positions3D,
      "webpath/node-positions-3d",
      model.positions3D.byteLength,
    );
    this.colors = this.replaceBuffer(this.colors, "webpath/node-colors", model.colors.byteLength);
    this.meta = this.replaceBuffer(this.meta, "webpath/node-meta", model.meta.byteLength);
    this.edges = this.replaceBuffer(this.edges, "webpath/edges", model.edgeIndices.byteLength);
    if (model.positions.byteLength) this.device.queue.writeBuffer(this.positions, 0, model.positions as Float32Array<ArrayBuffer>);
    if (model.positions3D.byteLength) {
      this.device.queue.writeBuffer(
        this.positions3D,
        0,
        model.positions3D as Float32Array<ArrayBuffer>,
      );
    }
    if (model.colors.byteLength) this.device.queue.writeBuffer(this.colors, 0, model.colors as Float32Array<ArrayBuffer>);
    if (model.meta.byteLength) this.device.queue.writeBuffer(this.meta, 0, model.meta as Float32Array<ArrayBuffer>);
    if (model.edgeIndices.byteLength) this.device.queue.writeBuffer(this.edges, 0, model.edgeIndices as Uint32Array<ArrayBuffer>);
    this.bindGeneration = -1;
  }

  private rebuildBindGroups(): void {
    if (
      !this.device ||
      !this.nodePipeline ||
      !this.edgePipeline ||
      !this.positions ||
      !this.positions3D ||
      !this.colors ||
      !this.meta ||
      !this.edges ||
      !this.uniform
    ) return;
    this.nodeBindGroup = this.device.createBindGroup({
      label: "webpath/nodes-bind-group",
      layout: this.nodePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.positions } },
        { binding: 1, resource: { buffer: this.positions3D } },
        { binding: 2, resource: { buffer: this.colors } },
        { binding: 3, resource: { buffer: this.meta } },
        { binding: 4, resource: { buffer: this.uniform } },
      ],
    });
    this.edgeBindGroup = this.device.createBindGroup({
      label: "webpath/edges-bind-group",
      layout: this.edgePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.positions } },
        { binding: 1, resource: { buffer: this.positions3D } },
        { binding: 2, resource: { buffer: this.colors } },
        { binding: 3, resource: { buffer: this.meta } },
        { binding: 4, resource: { buffer: this.edges } },
        { binding: 5, resource: { buffer: this.uniform } },
      ],
    });
    this.bindGeneration = this.bufferGeneration;
  }

  private ensureDepthTexture(device: GPUDevice, width: number, height: number): GPUTextureView {
    if (!this.depthTexture || this.depthWidth !== width || this.depthHeight !== height) {
      this.depthTexture?.destroy();
      this.depthWidth = width;
      this.depthHeight = height;
      this.depthTexture = device.createTexture({
        label: "webpath/depth",
        size: { width, height },
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    return this.depthTexture.createView();
  }

  private createDrawNode(): ComputeNode {
    return {
      name: "webpath-draw",
      inputs: [],
      outputs: ["framebuffer"],
      prepare: async (device: GPUDevice) => {
        const format = navigator.gpu.getPreferredCanvasFormat();
        const blend: GPUBlendState = {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        };
        const nodeModule = device.createShaderModule({ label: "WebPath node shader", code: NODE_SHADER });
        const edgeModule = device.createShaderModule({ label: "WebPath edge shader", code: EDGE_SHADER });
        await Promise.all([
          assertShaderValid(nodeModule, "node shader"),
          assertShaderValid(edgeModule, "edge shader"),
        ]);
        const depthStencil: GPUDepthStencilState = {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less",
        };
        [this.nodePipeline, this.edgePipeline] = await Promise.all([
          device.createRenderPipelineAsync({
            label: "WebPath nodes",
            layout: "auto",
            vertex: { module: nodeModule, entryPoint: "vs" },
            fragment: { module: nodeModule, entryPoint: "fs", targets: [{ format, blend }] },
            primitive: { topology: "triangle-list" },
            depthStencil,
          }),
          device.createRenderPipelineAsync({
            label: "WebPath edges",
            layout: "auto",
            vertex: { module: edgeModule, entryPoint: "vs" },
            fragment: { module: edgeModule, entryPoint: "fs", targets: [{ format, blend }] },
            primitive: { topology: "line-list" },
            depthStencil,
          }),
        ]);
        this.rebuildBindGroups();
      },
      execute: (ctx: ExecutionContext) => {
        if (!this.model || !this.nodePipeline || !this.edgePipeline || !this.uniform) return;
        if (this.bindGeneration !== this.bufferGeneration) this.rebuildBindGroups();
        if (!this.nodeBindGroup || !this.edgeBindGroup) return;
        const canvas = ctx.context.canvas as HTMLCanvasElement;
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        this.uniformData.set([
          width,
          height,
          this.camera.centerX,
          this.camera.centerY,
          this.camera.zoom,
          this.camera.nodeScale,
          this.camera.edgeAlpha,
          this.is3D() ? 1 : 0,
          this.camera.targetX,
          this.camera.targetY,
          this.camera.targetZ,
          this.camera.distance,
          this.camera.yaw,
          this.camera.pitch,
          this.camera.fov,
          performance.now() / 1000,
          0,
          0,
          0,
          0,
        ]);
        ctx.queue.writeBuffer(this.uniform, 0, this.uniformData);
        const depthView = this.ensureDepthTexture(
          ctx.device,
          Math.max(1, canvas.width),
          Math.max(1, canvas.height),
        );
        const pass = ctx.encoder.beginRenderPass({
          label: "WebPath graph pass",
          colorAttachments: [{
            view: ctx.canvasView,
            clearValue: { r: 0.012, g: 0.027, b: 0.025, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          }],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "discard",
          },
          timestampWrites: ctx.timestampWrites?.("WebPath graph"),
        });
        if (this.model.edgeIndices.length) {
          pass.setPipeline(this.edgePipeline);
          pass.setBindGroup(0, this.edgeBindGroup);
          pass.draw(2, this.model.edgeIndices.length / 2);
        }
        if (this.model.nodes.length) {
          pass.setPipeline(this.nodePipeline);
          pass.setBindGroup(0, this.nodeBindGroup);
          pass.draw(6, this.model.nodes.length);
        }
        pass.end();
      },
    };
  }

  private disposeGpu(): void {
    this.positions?.destroy();
    this.positions3D?.destroy();
    this.colors?.destroy();
    this.meta?.destroy();
    this.edges?.destroy();
    this.uniform?.destroy();
    this.depthTexture?.destroy();
    this.positions = null;
    this.positions3D = null;
    this.colors = null;
    this.meta = null;
    this.edges = null;
    this.uniform = null;
    this.depthTexture = null;
    this.nodePipeline = this.edgePipeline = null;
    this.nodeBindGroup = this.edgeBindGroup = null;
    this.device = null;
  }
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

function normalize(value: readonly number[]): [number, number, number] {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!) || 1;
  return [value[0]! / length, value[1]! / length, value[2]! / length];
}

export async function startShallotRenderer(renderer: ShallotGraphRenderer): Promise<State> {
  const config: Config = {
    defaults: false,
    loading: NoLoading,
    plugins: [ComputePlugin, ViewportPlugin, renderer.plugin],
  };
  return run(config);
}
