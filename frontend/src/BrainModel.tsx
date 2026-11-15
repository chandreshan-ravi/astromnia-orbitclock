
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";

function Brain({ onSelect }: { onSelect: () => void }) {
  const { scene } = useGLTF("/models/Brain.glb");
  const brainRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (brainRef.current) {
      brainRef.current.rotation.y += delta * 0.5;
    }
  });

  return (
    <group ref={brainRef}>
      <primitive object={scene} scale={1.5} />

      {/* Larger invisible click area */}
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <sphereGeometry args={[1.35, 32, 32]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

export default function BrainModel({
  onPinealClick = () => {}
}: {
  onPinealClick?: () => void;
}) {
  return (
    <div style={{ width: "100%", height: "320px" }}>
      <Canvas camera={{ position: [0, 0, 4], fov: 45 }}>
        <ambientLight intensity={1.5} />
        <directionalLight position={[3, 3, 3]} intensity={2} />

        <Brain onSelect={onPinealClick} />

        <OrbitControls enableRotate enableZoom enablePan={false} />
      </Canvas>
    </div>
  );
}
