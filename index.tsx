import React, { useState, useRef, useMemo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, OrthographicCamera, Text } from '@react-three/drei';
import * as THREE from 'three';
import { Plus, Trash2, Play, Pause, RotateCcw, Menu, ChevronLeft, Dices, RefreshCw, Gauge, Activity, Waves as WavesIcon, Box, Layers, Eye, EyeOff } from 'lucide-react';
import { deserializeSettings, SerializedState, serializeSettings } from './protobufHelpers';

// --- Types & Constants ---

interface WaveSource {
  id: string;
  x: number;
  y: number;
  amplitude: number; // s_max
  frequency: number; // omega
  phase: number;     // delta_phi
  visible: boolean;  // toggle for active/inactive
}

const MAX_SOURCES = 10;

// Default values
const DEFAULT_SOURCE_PARAMS = {
  amplitude: 1.0,
  frequency: 2.0,
  phase: 0.0,
};

// Data/Parameter Modes
enum ParamMode {
  Elongation = 0,
  Velocity = 1,
  Acceleration = 2,
  Amplitude = 3, // Envelope
  Phase = 4      // Mean Pairwise Phase Difference
}

export interface AppState {
  sources: Array<{
    id: string;
    x: number;
    y: number;
    amplitude: number;
    frequency: number;
    phase: number;
    visible: boolean;
  }>;
  globalSpeed: number;
  appMode: AppMode;
  paramMode: ParamMode;
}

// Main App Modes
enum AppMode {
  Waves = 0,       // Realistic Water Shader, 3D
  Params3D = 1, // Data Color, 3D Shaded
  Params2D = 2  // Data Color, 2D Flat
}

// --- URL state (base64) helpers ---
const SETTINGS_VERSION = 0x01;

const base64EncodeBytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64DecodeBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const convertState = (appState: AppState): SerializedState => {
  return {
    appMode: appState.appMode as number,
    paramMode: appState.paramMode as number,
    ...appState,
  };
};

const deconvertState = (state: SerializedState): AppState => {
  return {
    appMode: state.appMode as AppMode,
    paramMode: state.paramMode as ParamMode,
    ...state,
  };
};

const encodeState = (obj: AppState) => {
  try {
    const serialized = serializeSettings(convertState(obj));
    // Prepend version byte
    const withVersion = new Uint8Array(serialized.length + 1);
    withVersion[0] = SETTINGS_VERSION;
    withVersion.set(serialized, 1);
    return base64EncodeBytes(withVersion);
  } catch (e) {
    return '';
  }
};

const decodeState = (b64: string): AppState | null => {
  try {
    const bytes = base64DecodeBytes(b64);
    if (bytes.length < 1) return null;
    
    const version = bytes[0];
    if (version !== SETTINGS_VERSION) {
      console.warn('[state] unsupported version:', version);
      return null;
    }
    
    const payload = bytes.slice(1);
    const deserialized = deserializeSettings(payload);
    if (!deserialized) return null;
    return deconvertState(deserialized);
  } catch (e) {
    return null;
  }
};

// --- Shader Helper for Environment ---
// Shared logic for Skybox and Water Reflection
const skyColorLogic = `
vec3 getSkyColor(vec3 dir) {
    vec3 sunDir = normalize(vec3(50.0, 20.0, -50.0)); // Matches light direction
    float sun = max(dot(dir, sunDir), 0.0);
    
    // Gradient Colors
    vec3 skyTop = vec3(0.2, 0.5, 0.9);      // Deep Azure Zenith
    vec3 skyHorizon = vec3(0.6, 0.8, 0.95); // Pale Cyan Horizon
    vec3 oceanBottom = vec3(0.0, 0.3, 0.8); // Vibrant Blue Ocean Floor

    vec3 color;
    
    if (dir.y > -0.01) {
        // Sky blending
        float t = pow(max(dir.y, 0.0), 0.6);
        color = mix(skyHorizon, skyTop, t);
        
        // Sun Disc & Glow
        color += vec3(1.0, 1.0, 0.9) * pow(sun, 800.0);
        color += vec3(1.0, 0.8, 0.6) * pow(sun, 20.0) * 0.4;
    } else {
        // Ocean Floor blending
        float t = clamp(-dir.y, 0.0, 1.0);
        color = mix(skyHorizon * 0.6, oceanBottom, sqrt(t));
    }
    return color;
}
`;

// --- Shaders ---

const vertexShader = `
  varying vec2 vUv;
  varying float vValue;     // Value determining the color
  varying vec3 vPosition;   // Local position
  varying vec3 vWorldPosition; // World position for lighting
  varying float vElevation; // Absolute height
  varying vec3 vNormal;     // Smooth normal

  uniform float uTime;
  uniform float uGlobalSpeed;
  uniform int uSourceCount;
  uniform int uParamMode; 
  uniform int uRenderStyle; // 0=Params3D, 1=Water, 2=Params2D
  
  uniform vec2 uSourcePos[${MAX_SOURCES}];
  uniform vec3 uSourceParams[${MAX_SOURCES}]; // x: amp, y: freq, z: phase

  void main() {
    vUv = uv;
    vec3 localPos = position;

    // Calculate World Position of the vertex on the plane
    vec4 worldPosBase = modelMatrix * vec4(localPos, 1.0);
    // Physics simulation happens in World Space XZ
    vec2 simPos = vec2(worldPosBase.x, -worldPosBase.z);
    
    float elevation = 0.0; 
    float displayValue = 0.0; 

    // For analytical normals
    float dzdx = 0.0;
    float dzdy = 0.0;

    // Temp variables for phasor sums (Amplitude mode)
    float realSumSpatial = 0.0; 
    float imagSumSpatial = 0.0;
    
    // Array to store individual phases for pairwise difference calculation
    float phases[${MAX_SOURCES}];

    float safeSpeed = max(0.1, uGlobalSpeed);

    // --- Pass 1: Calculate Superposition & Store Phases ---
    for(int i = 0; i < ${MAX_SOURCES}; i++) {
      if (i >= uSourceCount) {
         phases[i] = 0.0;
         continue; 
      } else {
      
          vec2 sourcePos = uSourcePos[i];
          float amp = uSourceParams[i].x;
          float freq = uSourceParams[i].y;
          float phase = uSourceParams[i].z;
    
          float dist = distance(simPos, sourcePos);
          float safeDist = max(dist, 0.01); 
          
          // Wave argument (Total phase)
          // theta = omega * (t - r/c) + delta_phi
          float theta = freq * (uTime - dist / safeSpeed) + phase;
          phases[i] = theta; 
          
          float cosTheta = cos(theta);
          float sinTheta = sin(theta);
          
          // Damping for horizon
          float damp = 1.0; 
          if (uRenderStyle == 1 && dist > 1200.0) {
             damp = max(0.0, 1.0 - (dist - 1200.0) / 400.0);
          }
          
          float s = amp * sinTheta * damp;
          elevation += s;
    
          // Analytical Normals
          float dWave_dr = -(amp * freq * cosTheta * damp) / safeSpeed;
          float dr_dx = (simPos.x - sourcePos.x) / safeDist;
          float dr_dy = (simPos.y - sourcePos.y) / safeDist;
    
          dzdx += dWave_dr * dr_dx;
          dzdy += dWave_dr * dr_dy;
    
          // Accumulate Data Values
          if (uParamMode == 0) {
             displayValue += s;
          } else if (uParamMode == 1) {
             displayValue += amp * cosTheta; 
          } else if (uParamMode == 2) {
             displayValue += -amp * sinTheta;
          } else if (uParamMode == 3) {
             // Amplitude Envelope phasor sum
             realSumSpatial += amp * cos(theta);
             imagSumSpatial += amp * sin(theta);
          }
      }
    }
    
    // --- Pass 2: Finalize Values ---
    
    if (uParamMode == 3) {
      displayValue = sqrt(realSumSpatial * realSumSpatial + imagSumSpatial * imagSumSpatial);
    } 
    else if (uParamMode == 4) {
      // Mean Pairwise Phase Difference using Circular Mean
      float sumSin = 0.0;
      float sumCos = 0.0;
      float pairCount = 0.0;
      
      for (int i = 0; i < ${MAX_SOURCES}; i++) {
         if (i >= uSourceCount) break;
         for (int j = i + 1; j < ${MAX_SOURCES}; j++) {
            if (j >= uSourceCount) break;
            
            float diff = phases[i] - phases[j];
            sumSin += sin(diff);
            sumCos += cos(diff);
            pairCount += 1.0;
         }
      }
      
      if (pairCount > 0.0) {
          // Result in [-PI, PI]
          displayValue = atan(sumSin, sumCos);
      } else {
          displayValue = 0.0;
      }
    }
      
    // Update geometry Z position (Local Space)
    localPos.z += elevation;

    // Construct Normal
    vec3 objectNormal = normalize(vec3(-dzdx, -dzdy, 1.0));
    vNormal = normalize(mat3(modelMatrix) * objectNormal);

    vValue = displayValue;
    vPosition = localPos;
    vElevation = elevation;
    
    vec4 finalWorldPos = modelMatrix * vec4(localPos, 1.0);
    vWorldPosition = finalWorldPos.xyz;

    gl_Position = projectionMatrix * viewMatrix * finalWorldPos;
  }
`;

const fragmentShader = `
  varying float vValue;
  varying vec2 vUv;
  varying vec3 vPosition;
  varying vec3 vWorldPosition;
  varying float vElevation;
  varying vec3 vNormal; 

  uniform int uParamMode;
  uniform int uRenderStyle; // 0=Params3D, 1=Water, 2=Params2D

  ${skyColorLogic}

  // HSV to RGB helper
  vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec3 finalColor;
    float alpha = 1.0;
    
    // Fix normal for double-sided rendering
    vec3 normal = normalize(vNormal);
    if (!gl_FrontFacing) {
        normal = -normal;
    }

    // --- Water Mode (Waves) ---
    if (uRenderStyle == 1) {
        vec3 viewDir = normalize(vWorldPosition - cameraPosition); 
        vec3 viewReflect = reflect(viewDir, normal);
        
        // Sample Skybox for Reflection & Refraction
        vec3 reflectionColor = getSkyColor(viewReflect);
        vec3 refractionColor = getSkyColor(viewDir); 

        // Water Intrinsic Color (shallow tint)
        vec3 shallowColor = vec3(0.5, 0.8, 0.95); 

        // Fresnel calculation
        float fresnel = pow(1.0 - max(dot(-viewDir, normal), 0.0), 4.0);
        fresnel = clamp(fresnel, 0.0, 1.0);

        // Mix refraction and shallow tint
        vec3 bodyColor = mix(refractionColor, shallowColor, 0.3);

        // Apply Reflection
        finalColor = mix(bodyColor, reflectionColor, fresnel);
        
        // Specular Highlight (Sun)
        vec3 sunDir = normalize(vec3(50.0, 20.0, -50.0));
        float spec = pow(max(dot(viewReflect, sunDir), 0.0), 400.0);
        finalColor += vec3(1.0) * spec;

        // --- Horizon Blend ---
        float dist = distance(vWorldPosition.xz, cameraPosition.xz);
        float horizonFade = smoothstep(300.0, 750.0, dist);
        
        if (horizonFade > 0.0) {
           vec3 skyAtPoint = getSkyColor(normalize(vWorldPosition - cameraPosition));
           finalColor = mix(finalColor, skyAtPoint, horizonFade);
        }
        
        alpha = 1.0;
        
    } 
    // --- Data Mode (Params 3D / 2D) ---
    else {
        vec3 baseColor;
        float val = vValue;

        // Color Mapping
        if (uParamMode == 3) {
          // Amplitude: 0 (White) -> Max (Blue)
          float t = smoothstep(0.0, 2.0, val);
          baseColor = mix(vec3(1.0), vec3(0.0, 0.4, 1.0), t);
          if (val < 0.05) baseColor = vec3(1.0, 1.0, 1.0); // Node highlighting
          
        } else if (uParamMode == 4) {
           // Phase Difference: -PI to +PI
           // Map: Hue = fract(val / (2.0 * PI))
           float hue = fract(val / 6.2831853);
           baseColor = hsv2rgb(vec3(hue, 1.0, 1.0));

        } else {
          // s, v, a: Neg(Red) -> 0(White) -> Pos(Blue)
          float t = clamp(val / 1.5, -1.0, 1.0);
          vec3 red = vec3(1.0, 0.0, 0.0);
          vec3 white = vec3(1.0, 1.0, 1.0);
          vec3 blue = vec3(0.0, 0.0, 1.0);
          if (t > 0.0) baseColor = mix(white, blue, t);
          else baseColor = mix(white, red, -t);
        }

        // Apply Shading ONLY if it's Params 3D
        if (uRenderStyle == 0) {
            vec3 lightDir = normalize(vec3(0.5, 0.5, 1.0));
            float diffTop = max(dot(normal, lightDir), 0.0);
            float diffBottom = max(dot(normal, -lightDir), 0.0) * 0.5;
            
            vec3 ambient = baseColor * 0.6; 
            vec3 diffuse = baseColor * (diffTop + diffBottom) * 0.8; 
            
            vec3 viewDir = normalize(cameraPosition - vWorldPosition);
            vec3 reflectDir = reflect(-lightDir, normal);
            float spec = pow(max(dot(viewDir, reflectDir), 0.0), 32.0);
            
            finalColor = ambient + diffuse + vec3(spec * 0.2);
            finalColor = min(finalColor, vec3(1.2)); 
            alpha = 1.0;
        } else {
            finalColor = baseColor;
            alpha = 1.0;
        }
    }

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

const skyboxVertexShader = `
varying vec3 vWorldPosition;
void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const skyboxFragmentShader = `
varying vec3 vWorldPosition;
${skyColorLogic}

void main() {
    vec3 dir = normalize(vWorldPosition);
    vec3 color = getSkyColor(dir);
    gl_FragColor = vec4(color, 1.0);
}
`;

// --- Components ---

const Skybox = () => {
    return (
        <mesh renderOrder={-1}>
            <sphereGeometry args={[5000, 32, 32]} />
            <shaderMaterial 
                vertexShader={skyboxVertexShader}
                fragmentShader={skyboxFragmentShader}
                side={THREE.BackSide}
                depthWrite={false}
            />
        </mesh>
    );
};

const WaveMesh = ({ 
  sources, 
  globalSpeed,
  geometrySpeed,
  isPlaying, 
  timeRef, 
  paramMode,
  appMode
}: { 
  sources: WaveSource[], 
  globalSpeed: number, 
  geometrySpeed: number,
  isPlaying: boolean, 
  timeRef: React.MutableRefObject<number>, 
  paramMode: ParamMode,
  appMode: AppMode
}) => {
  const meshRef = useRef<THREE.Mesh>(null);
  
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uGlobalSpeed: { value: 5.0 },
    uSourceCount: { value: 0 },
    uSourcePos: { value: new Float32Array(MAX_SOURCES * 2) },
    uSourceParams: { value: new Float32Array(MAX_SOURCES * 3) },
    uParamMode: { value: 0 },
    uRenderStyle: { value: 0 }, // 0=Params3D, 1=Water, 2=Params2D
  }), []);

  // Dynamic resolution calculation
  const gridResolution = useMemo(() => {
     const s = Math.round(Math.max(1, geometrySpeed));
     // Formula: Res ~ 1/sqrt(speed)
     const res = Math.floor(2000 / Math.sqrt(s));
     return Math.max(400, Math.min(2000, res));
  }, [geometrySpeed]);

  // Custom Geometry Generation
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const resolution = gridResolution; 
    const size = 1600; 
    const halfSize = size / 2;
    
    const vertexCount = (resolution + 1) * (resolution + 1);
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    
    const power = 2.2; 

    let vIdx = 0;
    for (let i = 0; i <= resolution; i++) {
        for (let j = 0; j <= resolution; j++) {
            const u = i / resolution;
            const v = j / resolution;
            
            const rawX = u * 2 - 1;
            const rawY = v * 2 - 1;

            const x = Math.sign(rawX) * Math.pow(Math.abs(rawX), power) * halfSize;
            const y = Math.sign(rawY) * Math.pow(Math.abs(rawY), power) * halfSize;

            positions[vIdx * 3] = x;
            positions[vIdx * 3 + 1] = y;
            positions[vIdx * 3 + 2] = 0;
            
            uvs[vIdx * 2] = u;
            uvs[vIdx * 2 + 1] = v;
            vIdx++;
        }
    }

    const indexCount = resolution * resolution * 6;
    const indices = new Uint32Array(indexCount);
    
    let iIdx = 0;
    for (let i = 0; i < resolution; i++) {
        for (let j = 0; j < resolution; j++) {
            const a = i * (resolution + 1) + j;
            const b = i * (resolution + 1) + j + 1;
            const c = (i + 1) * (resolution + 1) + j;
            const d = (i + 1) * (resolution + 1) + j + 1;
            
            indices[iIdx++] = a;
            indices[iIdx++] = b;
            indices[iIdx++] = d;
            
            indices[iIdx++] = a;
            indices[iIdx++] = d;
            indices[iIdx++] = c;
        }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals(); 
    
    return geo;
  }, [gridResolution]);

  useFrame((state, delta) => {
    if (isPlaying) {
      timeRef.current += delta;
    }

    // Dynamic Grid Centering
    if (meshRef.current) {
        const controls = state.controls as any;
        if (controls && controls.target) {
            meshRef.current.position.x = controls.target.x;
            meshRef.current.position.z = controls.target.z;
        } else {
             meshRef.current.position.x = state.camera.position.x;
             meshRef.current.position.z = state.camera.position.z;
        }
        meshRef.current.position.y = 0;
    }
    
    uniforms.uTime.value = timeRef.current;
    uniforms.uGlobalSpeed.value = globalSpeed; 
    uniforms.uParamMode.value = paramMode;
    
    if (appMode === AppMode.Waves) uniforms.uRenderStyle.value = 1;
    else if (appMode === AppMode.Params2D) uniforms.uRenderStyle.value = 2;
    else uniforms.uRenderStyle.value = 0;
    
    const visibleSources = sources.filter(s => s.visible);
    uniforms.uSourceCount.value = visibleSources.length;
    
    const posArray = uniforms.uSourcePos.value as Float32Array;
    const paramsArray = uniforms.uSourceParams.value as Float32Array;
    
    visibleSources.forEach((source, i) => {
      if (i >= MAX_SOURCES) return;
      posArray[i * 2] = source.x;
      posArray[i * 2 + 1] = source.y;
      
      paramsArray[i * 3] = source.amplitude;
      paramsArray[i * 3 + 1] = source.frequency;
      paramsArray[i * 3 + 2] = source.phase;
    });
  });

  return (
    <mesh ref={meshRef} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        side={THREE.DoubleSide}
        transparent={false}
        depthWrite={true}
      />
    </mesh>
  );
};

const SingleSourceArrow: React.FC<{ 
    source: WaveSource, 
    timeRef: React.MutableRefObject<number>,
    label: string
}> = ({ source, timeRef, label }) => {
    const meshRef = useRef<THREE.Group>(null);
    const arrowRef = useRef<THREE.Group>(null);
    const coneRef = useRef<THREE.Mesh>(null);
    const cylRef = useRef<THREE.Mesh>(null);

    useFrame(() => {
        if (!meshRef.current || !arrowRef.current || !coneRef.current || !cylRef.current) return;
        
        if (!source.visible) {
             meshRef.current.visible = false;
             return;
        } else {
            meshRef.current.visible = true;
        }

        const t = timeRef.current;
        const elongation = source.amplitude * Math.sin(source.frequency * t + source.phase);

        meshRef.current.position.set(source.x, source.y, 0);

        const absVal = Math.abs(elongation);
        const isPositive = elongation >= 0;
        
        const color = isPositive ? new THREE.Color(0x22c55e) : new THREE.Color(0xef4444);
        (coneRef.current.material as THREE.MeshStandardMaterial).color = color;
        (cylRef.current.material as THREE.MeshStandardMaterial).color = color;

        if (absVal < 0.05) {
            arrowRef.current.visible = false;
        } else {
            arrowRef.current.visible = true;
            
            arrowRef.current.rotation.x = isPositive ? Math.PI / 2 : -Math.PI / 2;
            
            const headHeight = 0.5;
            let bodyHeight = absVal - headHeight;
            if (bodyHeight < 0) bodyHeight = 0.01;
            
            cylRef.current.scale.y = bodyHeight;
            cylRef.current.position.y = bodyHeight / 2;
            
            coneRef.current.position.y = bodyHeight + headHeight / 2;
        }
    });

    return (
        <group ref={meshRef}>
            <mesh position={[0, 0, 0]} renderOrder={999}>
                <sphereGeometry args={[0.15, 16, 16]} />
                <meshStandardMaterial color="white" depthTest={false} transparent={true} />
            </mesh>

            <group ref={arrowRef} rotation={[Math.PI/2, 0, 0]}>
                <mesh ref={cylRef} position={[0, 0.5, 0]} renderOrder={999}>
                    <cylinderGeometry args={[0.08, 0.08, 1, 8]} />
                    <meshStandardMaterial depthTest={false} transparent={true} />
                </mesh>
                <mesh ref={coneRef} position={[0, 1, 0]} renderOrder={999}>
                    <coneGeometry args={[0.2, 0.5, 16]} />
                    <meshStandardMaterial depthTest={false} transparent={true} />
                </mesh>
            </group>
            
            <Text
                position={[0.5, 0.5, 0.5]}
                rotation={[Math.PI / 2, 0, 0]}
                fontSize={0.5}
                color="white"
                anchorX="left"
                anchorY="bottom"
                outlineWidth={0.05}
                outlineColor="#000000"
                renderOrder={999}
                depthTest={false}
            >
                {label}
            </Text>
        </group>
    );
}

const SourceArrows = ({ sources, globalSpeed, timeRef }: { 
    sources: WaveSource[], 
    globalSpeed: number, 
    timeRef: React.MutableRefObject<number> 
}) => {
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {sources.map((source, index) => (
        <SingleSourceArrow 
            key={source.id} 
            source={source} 
            timeRef={timeRef}
            label={`E${index + 1}`}
        />
      ))}
    </group>
  );
};

const CameraController = ({ appMode }: { appMode: AppMode }) => {
  const is2D = appMode === AppMode.Params2D;
  return (
    <>
      {is2D ? (
        <OrthographicCamera makeDefault position={[0, 50, 0]} zoom={15} near={0.1} far={10000} onUpdate={c => c.lookAt(0, 0, 0)} />
      ) : (
        <PerspectiveCamera makeDefault position={[0, 30, 40]} fov={45} near={0.1} far={10000} onUpdate={c => c.lookAt(0, 0, 0)} />
      )}
      <OrbitControls 
        makeDefault
        enableRotate={!is2D} 
        enableZoom={true} 
        minZoom={5} 
        maxZoom={50}
        minDistance={5}
        maxDistance={2000}
        screenSpacePanning={false}
        maxPolarAngle={Math.PI / 2 - 0.05}
        target={[0, 0, 0]}
      />
    </>
  );
};

const LatexButton = ({ 
  label, 
  symbol, 
  active, 
  onClick 
}: { 
  label: string, 
  symbol: React.ReactNode, 
  active: boolean, 
  onClick: () => void 
}) => (
  <button 
    className={`view-option ${active ? 'active' : ''}`}
    onClick={onClick}
    title={label}
  >
    <div style={{
      fontFamily: '"Times New Roman", Times, serif', 
      fontSize: '1.2rem', 
      fontStyle: 'italic',
      fontWeight: 'bold',
      lineHeight: '1.2rem',
      height: '24px',
      display: 'flex',
      alignItems: 'center'
    }}>
      {symbol}
    </div>
    <span style={{
      fontSize: '0.6rem',
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: '0.5px'
    }}>{label}</span>
  </button>
);

const App = () => {
  const [globalSpeed, setGlobalSpeed] = useState(5.0);
  const [geometrySpeed, setGeometrySpeed] = useState(5.0); 

  const [sources, setSources] = useState<WaveSource[]>([
    { ...DEFAULT_SOURCE_PARAMS, id: '1', x: -5, y: 0, visible: true },
    { ...DEFAULT_SOURCE_PARAMS, id: '2', x: 5, y: 0, visible: true }
  ]);
  const [isPlaying, setIsPlaying] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  const [appMode, setAppMode] = useState<AppMode>(AppMode.Waves);
  const [paramMode, setParamMode] = useState<ParamMode>(ParamMode.Elongation);
  
  const timeRef = useRef(0);

  useEffect(() => {
    const handler = setTimeout(() => {
        setGeometrySpeed(globalSpeed);
    }, 2000);
    return () => clearTimeout(handler);
  }, [globalSpeed]);

  // Load state from URL hash (base64) on first mount
  useEffect(() => {
    try {
      const raw = window.location.hash.slice(1);
      if (!raw) return;
      const data = decodeState(raw);
      if (!data) return;

      if (Array.isArray(data.sources)) {
        setSources(data.sources.map((s: any) => ({ ...DEFAULT_SOURCE_PARAMS, ...s })));
      }
      if (typeof data.globalSpeed === 'number') setGlobalSpeed(data.globalSpeed);
      if (data.appMode && Object.values(AppMode).includes(data.appMode)) setAppMode(data.appMode as AppMode);
      if (typeof data.paramMode === 'number') setParamMode(data.paramMode);
    } catch (e) {
      // ignore malformed hash
    }
  }, []);

  // Persist selected pieces of state to URL hash (debounced)
  useEffect(() => {
    const payload = { sources, globalSpeed, appMode, paramMode };
    const b64 = encodeState(payload);
    const timer = setTimeout(() => {
      const newHash = b64 ? `#${b64}` : '';
      console.debug('[state] persisting to hash', { newHash });
      if (window.location.hash !== newHash) {
        history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [sources, globalSpeed, appMode, paramMode]);

  const addSource = () => {
    if (sources.length >= MAX_SOURCES) return;
    const newId = Math.random().toString(36).substr(2, 9);
    setSources([...sources, { ...DEFAULT_SOURCE_PARAMS, id: newId, x: Math.random() * 10 - 5, y: Math.random() * 10 - 5, visible: true }]);
  };

  const removeSource = (id: string) => {
    setSources(sources.filter(s => s.id !== id));
  };

  const toggleSourceVisibility = (id: string) => {
    setSources(sources.map(s => s.id === id ? { ...s, visible: !s.visible } : s));
  };

  const updateSource = (id: string, updates: Partial<WaveSource>) => {
    setSources(sources.map(s => s.id === id ? { ...s, ...updates } : s));
  };

  const resetTime = () => {
    timeRef.current = 0;
  };

  const randomizeSources = () => {
    const newSources = sources.map(s => ({
      ...s,
      x: (Math.random() - 0.5) * 30,
      y: (Math.random() - 0.5) * 30,
      amplitude: 0.5 + Math.random() * 2.5,
      frequency: 0.5 + Math.random() * 4.5,
      phase: Math.random() * Math.PI * 2,
      visible: true
    }));
    setSources(newSources);
  };

  const resetSourcesToStandard = () => {
    const count = sources.length;
    const spacing = 6; 
    
    const newSources = sources.map((s, index) => {
      const xPos = (index - (count - 1) / 2) * spacing;
      return {
        ...s,
        ...DEFAULT_SOURCE_PARAMS,
        x: xPos,
        y: 0,
        visible: true
      };
    });
    setSources(newSources);
    setGlobalSpeed(5.0);
  };

  const handleSceneFog = (mode: AppMode, scene: THREE.Scene) => {
    scene.fog = null;
  };

  return (
    <>
      <Canvas shadows dpr={[1, 2]} onCreated={({ scene }) => handleSceneFog(appMode, scene)}>
        {appMode === AppMode.Waves ? (
           <Skybox />
        ) : (
           <color attach="background" args={['#050505']} />
        )}
        
        <CameraController appMode={appMode} />
        
        <ambientLight intensity={0.5} />

        <WaveMesh 
          sources={sources} 
          globalSpeed={globalSpeed} 
          geometrySpeed={geometrySpeed}
          isPlaying={isPlaying} 
          timeRef={timeRef} 
          paramMode={paramMode}
          appMode={appMode}
        />
        <SourceArrows 
            sources={sources} 
            globalSpeed={globalSpeed} 
            timeRef={timeRef} 
        />
      </Canvas>

      <div className="ui-container">
        {!sidebarOpen && (
          <button className="toggle-btn btn btn-secondary" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
        )}

        <div className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
          <div className="header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h1>Wellen-Labor</h1>
              <button className="btn-icon" onClick={() => setSidebarOpen(false)}>
                <ChevronLeft size={20} />
              </button>
            </div>
          </div>

          <div className="scrollable-content">
            <div className="section-title">
              <Layers size={14} /> Modus
            </div>
            
            <div className="view-selector">
               <button 
                className={`view-option ${appMode === AppMode.Waves ? 'active' : ''}`}
                onClick={() => setAppMode(AppMode.Waves)}
              >
                <WavesIcon size={16} />
                <span>Wellen</span>
              </button>
              <button 
                className={`view-option ${appMode === AppMode.Params3D ? 'active' : ''}`}
                onClick={() => setAppMode(AppMode.Params3D)}
              >
                <Box size={16} />
                <span>Params 3D</span>
              </button>
              <button 
                className={`view-option ${appMode === AppMode.Params2D ? 'active' : ''}`}
                onClick={() => setAppMode(AppMode.Params2D)}
              >
                <Layers size={16} />
                <span>Params 2D</span>
              </button>
            </div>

            {appMode !== AppMode.Waves && (
              <>
                <div className="section-title">
                  <Activity size={14} /> Parameter
                </div>
                <div className="view-selector">
                  <LatexButton 
                    label="Pos" 
                    symbol="s" 
                    active={paramMode === ParamMode.Elongation}
                    onClick={() => setParamMode(ParamMode.Elongation)}
                  />
                  <LatexButton 
                    label="Vel" 
                    symbol="v" 
                    active={paramMode === ParamMode.Velocity}
                    onClick={() => setParamMode(ParamMode.Velocity)}
                  />
                  <LatexButton 
                    label="Acc" 
                    symbol="a" 
                    active={paramMode === ParamMode.Acceleration}
                    onClick={() => setParamMode(ParamMode.Acceleration)}
                  />
                  <LatexButton 
                    label="Amp" 
                    symbol={<span>s<sub style={{fontSize:'0.7em', fontStyle:'normal'}}>max</sub></span>} 
                    active={paramMode === ParamMode.Amplitude}
                    onClick={() => setParamMode(ParamMode.Amplitude)}
                  />
                  <LatexButton 
                    label="Phase" 
                    symbol="Δφ" 
                    active={paramMode === ParamMode.Phase}
                    onClick={() => setParamMode(ParamMode.Phase)}
                  />
                </div>

                <div className="legend">
                  {paramMode === ParamMode.Phase ? (
                    <>
                      <div className="legend-label" style={{justifyContent: 'space-between'}}>
                         <span style={{color:'#00ffff'}}>-π</span>
                         <span style={{color:'#ff0000'}}>0</span>
                         <span style={{color:'#00ffff'}}>+π</span>
                      </div>
                      <div className="gradient-bar" style={{
                        background: 'linear-gradient(90deg, #00ffff, #ff00ff, #ff0000, #ffff00, #00ffff)'
                      }}></div>
                    </>
                  ) : (
                    <>
                      <div className="legend-label">Rot (-)</div>
                      <div className="gradient-bar"></div>
                      <div className="legend-label">Blau (+)</div>
                    </>
                  )}
                </div>
              </>
            )}

            <div className="section-title" style={{ marginTop: '20px' }}>
               <Gauge size={14} /> Medium
            </div>
            <div className="source-card">
                <div className="control-group">
                  <label>Ausbreitungsgeschw. c (m/s) <span>{globalSpeed.toFixed(1)}</span></label>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    step="0.5"
                    value={globalSpeed}
                    onChange={(e) => setGlobalSpeed(parseFloat(e.target.value))}
                  />
                </div>
            </div>

            <div className="section-title" style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between' }}>
              <span><Activity size={14} style={{display:'inline', verticalAlign:'middle'}}/> Erreger</span>
              <span style={{fontSize: '0.7rem', color: '#64748b'}}>{sources.length}/10</span>
            </div>
            
            <div style={{display:'flex', gap: '8px', marginBottom: '10px', flexShrink: 0}}>
               <button className="btn btn-secondary" style={{flex: 1, padding: '6px', fontSize:'0.8rem'}} onClick={randomizeSources} title="Parameter würfeln">
                  <Dices size={14} style={{marginRight:4}}/> Würfeln
               </button>
               <button className="btn btn-secondary" style={{flex: 1, padding: '6px', fontSize:'0.8rem'}} onClick={resetSourcesToStandard} title="Reset auf Standard">
                  <RefreshCw size={14} style={{marginRight:4}}/> Reset
               </button>
            </div>

            <div className="controls-list">
              {sources.map((source, index) => (
                <div key={source.id} className="source-card" style={{ opacity: source.visible ? 1 : 0.6 }}>
                  <div className="card-header">
                    <span className="card-title">Erreger {index + 1}</span>
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn-icon" onClick={() => toggleSourceVisibility(source.id)} title={source.visible ? "Verstecken" : "Anzeigen"}>
                        {source.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                      </button>
                      <button className="btn-icon" onClick={() => removeSource(source.id)} title="Löschen">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  {source.visible && (
                    <>
                      <div className="control-group">
                        <label>Position X (m) <span>{source.x.toFixed(1)}</span></label>
                        <input
                          type="range"
                          min="-20"
                          max="20"
                          step="0.5"
                          value={source.x}
                          onChange={(e) => updateSource(source.id, { x: parseFloat(e.target.value) })}
                        />
                      </div>
                      
                      <div className="control-group">
                        <label>Position Y (m) <span>{source.y.toFixed(1)}</span></label>
                        <input
                          type="range"
                          min="-20"
                          max="20"
                          step="0.5"
                          value={source.y}
                          onChange={(e) => updateSource(source.id, { y: parseFloat(e.target.value) })}
                        />
                      </div>

                      <div className="control-group">
                        <label>Amplitude (m) <span>{source.amplitude.toFixed(2)}</span></label>
                        <input
                          type="range"
                          min="0"
                          max="5"
                          step="0.1"
                          value={source.amplitude}
                          onChange={(e) => updateSource(source.id, { amplitude: parseFloat(e.target.value) })}
                        />
                      </div>

                      <div className="control-group">
                        <label>Frequenz ω (rad/s) <span>{source.frequency.toFixed(2)}</span></label>
                        <input
                          type="range"
                          min="0.1"
                          max="10"
                          step="0.1"
                          value={source.frequency}
                          onChange={(e) => updateSource(source.id, { frequency: parseFloat(e.target.value) })}
                        />
                      </div>

                      <div className="control-group">
                        <label>Phase φ (rad) <span>{source.phase.toFixed(2)}</span></label>
                        <input
                          type="range"
                          min="0"
                          max={Math.PI * 2}
                          step="0.1"
                          value={source.phase}
                          onChange={(e) => updateSource(source.id, { phase: parseFloat(e.target.value) })}
                        />
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="actions">
            <button className="btn btn-secondary" onClick={addSource} disabled={sources.length >= MAX_SOURCES} style={{flex: 1}}>
              <Plus size={20} /> Erreger
            </button>
            <button className="btn" onClick={() => setIsPlaying(!isPlaying)} title={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button className="btn btn-secondary" onClick={resetTime} title="Zeit zurücksetzen">
               <RotateCcw size={20} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);