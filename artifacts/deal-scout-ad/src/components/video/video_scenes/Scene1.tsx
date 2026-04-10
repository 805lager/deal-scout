import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex items-center justify-center flex-col"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative z-10 text-center">
        <motion.h1 
          className="text-[8vw] font-black leading-none text-error uppercase italic tracking-tighter"
          initial={{ y: 50, opacity: 0, rotateX: 20 }}
          animate={{ y: 0, opacity: 1, rotateX: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          Stop
        </motion.h1>
        
        <motion.h1 
          className="text-[8vw] font-black leading-none text-white uppercase italic tracking-tighter"
          initial={{ y: 50, opacity: 0, rotateX: 20 }}
          animate={phase >= 1 ? { y: 0, opacity: 1, rotateX: 0 } : { y: 50, opacity: 0, rotateX: 20 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          Overpaying.
        </motion.h1>

        <motion.h1 
          className="text-[8vw] font-black leading-none text-error uppercase italic tracking-tighter mt-4"
          initial={{ y: 50, opacity: 0, rotateX: 20 }}
          animate={phase >= 2 ? { y: 0, opacity: 1, rotateX: 0 } : { y: 50, opacity: 0, rotateX: 20 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          Stop Getting
        </motion.h1>

        <motion.h1 
          className="text-[8vw] font-black leading-none text-white uppercase italic tracking-tighter"
          initial={{ y: 50, opacity: 0, rotateX: 20 }}
          animate={phase >= 2 ? { y: 0, opacity: 1, rotateX: 0 } : { y: 50, opacity: 0, rotateX: 20 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20, delay: 0.1 }}
        >
          Scammed.
        </motion.h1>
      </div>

      {/* Floating alert boxes */}
      <motion.div 
        className="absolute w-[25vw] bg-bg-muted border border-error/50 p-4 rounded-xl top-[20%] left-[10%] rotate-[-5deg]"
        initial={{ opacity: 0, scale: 0.8, x: -50 }}
        animate={phase >= 1 ? { opacity: 1, scale: 1, x: 0 } : { opacity: 0, scale: 0.8, x: -50 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-error flex items-center justify-center text-white font-bold">!</div>
          <div>
            <div className="text-white font-bold text-lg">Overpriced</div>
            <div className="text-error font-mono text-sm">+45% vs retail</div>
          </div>
        </div>
      </motion.div>

      <motion.div 
        className="absolute w-[25vw] bg-bg-muted border border-error/50 p-4 rounded-xl bottom-[20%] right-[10%] rotate-[5deg]"
        initial={{ opacity: 0, scale: 0.8, x: 50 }}
        animate={phase >= 2 ? { opacity: 1, scale: 1, x: 0 } : { opacity: 0, scale: 0.8, x: 50 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-error flex items-center justify-center text-white font-bold">×</div>
          <div>
            <div className="text-white font-bold text-lg">Scam Alert</div>
            <div className="text-error font-mono text-sm">Suspicious listing</div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
