import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

const SCENE_DURATIONS = {
  hook: 3500,
  scoring: 5000,
  features: 5500,
  demo: 7000,
  close: 4000,
};

const bgPos = [
  { x: '20vw', y: '30vh', scale: 2.0, opacity: 0.4, hue: 0 },
  { x: '60vw', y: '50vh', scale: 1.5, opacity: 0.5, hue: 120 },
  { x: '40vw', y: '20vh', scale: 2.5, opacity: 0.3, hue: 80 },
  { x: '50vw', y: '60vh', scale: 1.8, opacity: 0.4, hue: 140 },
  { x: '30vw', y: '40vh', scale: 2.2, opacity: 0.5, hue: 100 },
];

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });

  return (
    <div className="w-full h-screen overflow-hidden relative bg-slate-900 text-white">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 to-slate-950" />

        <motion.div
          className="absolute w-[40vw] h-[40vw] rounded-full blur-[100px] pointer-events-none"
          style={{ background: 'var(--color-primary)' }}
          animate={{
            x: bgPos[currentScene].x,
            y: bgPos[currentScene].y,
            scale: bgPos[currentScene].scale,
            opacity: bgPos[currentScene].opacity,
            filter: `blur(100px) hue-rotate(${bgPos[currentScene].hue}deg)`
          }}
          transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1] }}
        />

        <motion.div
          className="absolute w-[50vw] h-[50vw] rounded-full blur-[120px] pointer-events-none mix-blend-screen"
          style={{ background: 'var(--color-accent)' }}
          animate={{
            x: ['70vw', '15vw', '50vw', '30vw', '60vw'][currentScene],
            y: ['15vh', '70vh', '25vh', '55vh', '40vh'][currentScene],
            scale: [1.2, 1.5, 0.9, 1.3, 1.0][currentScene],
            opacity: [0.25, 0.4, 0.35, 0.3, 0.2][currentScene],
          }}
          transition={{ duration: 2, ease: [0.22, 1, 0.36, 1] }}
        />

        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noiseFilter\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.65\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noiseFilter)\'/%3E%3C/svg%3E")' }} />
      </div>

      <motion.div
        className="absolute h-[2px] z-20 pointer-events-none"
        style={{ background: 'linear-gradient(90deg, transparent, #10B981, transparent)' }}
        animate={{
          left: ['15%', '5%', '40%', '20%', '25%'][currentScene],
          width: ['25%', '50%', '30%', '40%', '35%'][currentScene],
          top: ['50%', '20%', '80%', '40%', '55%'][currentScene],
          opacity: [0.4, 0.6, 0.5, 0.3, 0.2][currentScene],
        }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      />

      <div className="relative z-10 w-full h-full">
        <AnimatePresence mode="sync">
          {currentScene === 0 && <Scene1 key="hook" />}
          {currentScene === 1 && <Scene2 key="scoring" />}
          {currentScene === 2 && <Scene3 key="features" />}
          {currentScene === 3 && <Scene4 key="demo" />}
          {currentScene === 4 && <Scene5 key="close" />}
        </AnimatePresence>
      </div>
    </div>
  );
}
