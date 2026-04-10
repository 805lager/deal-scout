import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import demoScreenshot from "@assets/Screenshot_2026-04-10_143449_1775857180037.png";

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 3000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, scale: 1.2 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, filter: 'blur(15px)' }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="absolute top-[5vh] text-center z-20"
        initial={{ opacity: 0, y: -30 }}
        animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: -30 }}
        transition={{ duration: 0.5 }}
      >
        <h2 className="text-[2.5vw] font-bold text-white" style={{ fontFamily: 'var(--font-display)' }}>
          Watch It Work
        </h2>
      </motion.div>

      <motion.div
        className="relative mt-[3vh]"
        initial={{ opacity: 0, y: 60, scale: 0.8 }}
        animate={phase >= 1 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 60, scale: 0.8 }}
        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="relative w-[70vw] h-[60vh] rounded-2xl overflow-hidden border-2 border-emerald-500/30 shadow-[0_0_60px_rgba(16,185,129,0.15),0_20px_50px_rgba(0,0,0,0.5)]">
          <img
            src={demoScreenshot}
            className="w-full h-full object-cover object-center"
            alt="Deal Scout in action on Facebook Marketplace"
          />

          <motion.div
            className="absolute inset-0 bg-gradient-to-t from-slate-950/40 via-transparent to-transparent pointer-events-none"
            initial={{ opacity: 0 }}
            animate={phase >= 1 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 1 }}
          />

          <div className="absolute inset-0 pointer-events-none rounded-2xl border border-white/5" />
        </div>
      </motion.div>

      <motion.div
        className="absolute bottom-[5vh] flex items-center gap-4 z-20"
        initial={{ opacity: 0, y: 20 }}
        animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
        transition={{ duration: 0.5 }}
      >
        <motion.div
          className="px-5 py-2.5 rounded-full bg-emerald-500/20 border border-emerald-500/40"
          animate={phase >= 2 ? { scale: [1, 1.04, 1] } : {}}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        >
          <span className="text-[1.1vw] text-emerald-300 font-medium">Scores in seconds</span>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
