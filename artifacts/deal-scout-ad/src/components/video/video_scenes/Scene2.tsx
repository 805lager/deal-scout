import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex items-center justify-center"
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0, scale: 1.1 }}
      transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="text-center relative z-10 w-full max-w-4xl px-8">
        <motion.div
          className="inline-block px-6 py-2 rounded-full border border-accent/30 bg-accent/10 text-accent font-mono font-bold mb-8 tracking-widest text-lg"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          MEET YOUR SHOPPING BODYGUARD
        </motion.div>

        <motion.h2 
          className="text-[6vw] font-black leading-tight text-white mb-6"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          Deal Scout AI
        </motion.h2>

        <div className="grid grid-cols-3 gap-6 mt-12">
          {['Instantly scores deals', 'Compares real sold data', 'Flags scams on the fly'].map((text, i) => (
            <motion.div
              key={i}
              className="bg-bg-light/80 backdrop-blur-md border border-white/10 p-6 rounded-2xl flex flex-col items-center gap-4 shadow-xl"
              initial={{ opacity: 0, y: 40, scale: 0.9 }}
              animate={phase >= i + 1 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 40, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center text-accent text-2xl font-bold">
                {i + 1}
              </div>
              <div className="text-white/80 font-bold text-xl text-center leading-snug">{text}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
