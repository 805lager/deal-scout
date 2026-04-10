import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1800),
      setTimeout(() => setPhase(3), 2800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex items-center justify-center flex-col bg-bg-dark"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1 }}
    >
      <div className="text-center relative z-10">
        <motion.div
          className="mb-8 flex justify-center"
          initial={{ scale: 0, rotate: -180 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          {/* Logo Mark Placeholder */}
          <div className="w-32 h-32 bg-accent rounded-3xl rotate-12 flex items-center justify-center shadow-[0_0_50px_rgba(0,240,255,0.4)]">
             <div className="w-24 h-24 border-4 border-bg-dark rounded-2xl -rotate-12 flex items-center justify-center">
               <span className="text-bg-dark font-black text-4xl">DS</span>
             </div>
          </div>
        </motion.div>

        <motion.h1 
          className="text-[7vw] font-black leading-none text-white tracking-tighter"
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          Deal Scout.
        </motion.h1>

        <motion.h2 
          className="text-3xl font-bold text-accent mt-4 font-mono uppercase tracking-widest"
          initial={{ y: 20, opacity: 0 }}
          animate={phase >= 1 ? { y: 0, opacity: 1 } : { y: 20, opacity: 0 }}
          transition={{ duration: 0.6 }}
        >
          Deal Scout has your back.
        </motion.h2>

        <motion.p 
          className="mt-12 text-white/50 text-xl tracking-wide"
          style={{ fontFamily: 'var(--font-body)' }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          Free Chrome Extension
        </motion.p>
      </div>
    </motion.div>
  );
}
