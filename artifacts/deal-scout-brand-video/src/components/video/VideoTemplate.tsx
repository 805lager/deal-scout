import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';
import { Scene6 } from './video_scenes/Scene6';
import { Scene7 } from './video_scenes/Scene7';
import storeLogo from "@assets/store_icon_128_1775856297061.png";

const SCENE_DURATIONS = {
  hook: 8000,
  problem: 8000,
  solution: 7000,
  scoring: 9000,
  reputation: 9000,
  demo: 10000,
  close: 7000
};

const bgPos = [
  { x: '10vw', y: '20vh', scale: 1.5, opacity: 0.4, hue: 0 },
  { x: '70vw', y: '60vh', scale: 2.0, opacity: 0.6, hue: 30 },
  { x: '50vw', y: '50vh', scale: 3.0, opacity: 0.3, hue: 120 },
  { x: '20vw', y: '80vh', scale: 1.2, opacity: 0.5, hue: 150 },
  { x: '60vw', y: '30vh', scale: 1.8, opacity: 0.4, hue: 100 },
  { x: '40vw', y: '50vh', scale: 2.2, opacity: 0.35, hue: 80 },
  { x: '45vw', y: '40vh', scale: 2.5, opacity: 0.4, hue: 140 }
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
          transition={{ duration: 2, ease: [0.22, 1, 0.36, 1] }}
        />

        <motion.div
          className="absolute w-[50vw] h-[50vw] rounded-full blur-[120px] pointer-events-none mix-blend-screen"
          style={{ background: 'var(--color-accent)' }}
          animate={{
            x: ['80vw', '10vw', '60vw', '30vw', '70vw', '15vw', '50vw'][currentScene],
            y: ['10vh', '80vh', '20vh', '60vh', '40vh', '70vh', '50vh'][currentScene],
            scale: [1, 1.5, 0.8, 1.2, 1.4, 0.9, 1.5][currentScene],
            opacity: [0.3, 0.5, 0.4, 0.6, 0.35, 0.45, 0.3][currentScene],
          }}
          transition={{ duration: 2.5, ease: [0.22, 1, 0.36, 1] }}
        />

        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noiseFilter\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.65\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noiseFilter)\'/%3E%3C/svg%3E")' }} />
      </div>

      <motion.div
        className="absolute top-[4vh] left-[4vw] z-50 flex items-center gap-3"
        animate={{ opacity: currentScene > 0 && currentScene < 6 ? 1 : 0, y: currentScene > 0 ? 0 : -20 }}
        transition={{ duration: 0.8 }}
      >
        <img src={storeLogo} className="w-8 h-8 object-contain rounded-lg" alt="Deal Scout" />
        <span className="font-bold text-xl tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>Deal Scout</span>
      </motion.div>

      <motion.div
        className="absolute h-[2px] z-20 pointer-events-none"
        style={{ background: 'linear-gradient(90deg, transparent, #10B981, transparent)' }}
        animate={{
          left: ['10%', '5%', '30%', '15%', '50%', '25%', '20%'][currentScene],
          width: ['30%', '60%', '25%', '45%', '35%', '50%', '40%'][currentScene],
          top: ['50%', '15%', '85%', '35%', '65%', '45%', '55%'][currentScene],
          opacity: [0.3, 0.6, 0.4, 0.5, 0.3, 0.4, 0.2][currentScene],
        }}
        transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
      />

      <div className="relative z-10 w-full h-full">
        <AnimatePresence mode="sync">
          {currentScene === 0 && <Scene1 key="hook" />}
          {currentScene === 1 && <Scene2 key="problem" />}
          {currentScene === 2 && <Scene3 key="solution" />}
          {currentScene === 3 && <Scene4 key="scoring" />}
          {currentScene === 4 && <Scene5 key="reputation" />}
          {currentScene === 5 && <Scene6 key="demo" />}
          {currentScene === 6 && <Scene7 key="close" />}
        </AnimatePresence>
      </div>
    </div>
  );
}
