import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

const SCENE_DURATIONS = { open: 4000, build1: 4500, build2: 5000, build3: 4500, close: 5000 };

const bgPos = [
  { scale: 1.2, x: '0%', y: '0%', opacity: 0.15 },
  { scale: 1.5, x: '-10%', y: '10%', opacity: 0.2 },
  { scale: 1.8, x: '5%', y: '-5%', opacity: 0.15 },
  { scale: 1.3, x: '-5%', y: '-10%', opacity: 0.25 },
  { scale: 1.1, x: '0%', y: '0%', opacity: 0.1 },
];

const accentColors = [
  'radial-gradient(circle, #FF3366, transparent)', // Scene 1: Scam/Warning (Red)
  'radial-gradient(circle, #00F0FF, transparent)', // Scene 2: AI/Tech (Blue)
  'radial-gradient(circle, #00FFA3, transparent)', // Scene 3: Good Deal (Green)
  'radial-gradient(circle, #FF3366, transparent)', // Scene 4: Scam (Red)
  'radial-gradient(circle, #00F0FF, transparent)', // Scene 5: Outro (Blue)
];

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });

  return (
    <div className="relative w-full h-screen overflow-hidden bg-bg-dark" style={{ backgroundColor: 'var(--color-bg-dark)' }}>
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        {/* Animated Grid Pattern */}
        <div 
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: 'linear-gradient(var(--color-bg-light) 1px, transparent 1px), linear-gradient(90deg, var(--color-bg-light) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
            transform: 'perspective(500px) rotateX(60deg) scale(2)',
            transformOrigin: 'center top'
          }}
        />
        
        {/* Shifting Glows */}
        <motion.div 
          className="absolute w-[800px] h-[800px] rounded-full blur-[100px] -top-[200px] -left-[200px]"
          animate={{
            background: accentColors[currentScene],
            scale: bgPos[currentScene].scale,
            x: bgPos[currentScene].x,
            y: bgPos[currentScene].y,
            opacity: bgPos[currentScene].opacity,
          }}
          transition={{ duration: 2, ease: "easeInOut" }}
        />
        
        <motion.div 
          className="absolute w-[600px] h-[600px] rounded-full blur-[100px] -bottom-[100px] -right-[100px]"
          animate={{
            background: 'radial-gradient(circle, #1F2833, transparent)',
            scale: [1, 1.2, 1],
            x: ['0%', '-5%', '0%'],
          }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      {/* Midground Elements - Persist and Transform */}
      <motion.div
        className="absolute w-full h-1 top-0 left-0 origin-left"
        animate={{
          backgroundColor: currentScene === 0 || currentScene === 3 ? 'var(--color-error)' : 
                          currentScene === 2 ? 'var(--color-success)' : 'var(--color-accent)',
          scaleX: [(currentScene) * 0.2, (currentScene + 1) * 0.2]
        }}
        transition={{ duration: SCENE_DURATIONS[Object.keys(SCENE_DURATIONS)[currentScene] as keyof typeof SCENE_DURATIONS] / 1000, ease: "linear" }}
      />

      {/* Foreground Scenes */}
      <div className="absolute inset-0 z-10">
        <AnimatePresence mode="popLayout">
          {currentScene === 0 && <Scene1 key="open" />}
          {currentScene === 1 && <Scene2 key="build1" />}
          {currentScene === 2 && <Scene3 key="build2" />}
          {currentScene === 3 && <Scene4 key="build3" />}
          {currentScene === 4 && <Scene5 key="close" />}
        </AnimatePresence>
      </div>
    </div>
  );
}
