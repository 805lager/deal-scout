import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 3000),
      setTimeout(() => setPhase(4), 5000),
      setTimeout(() => setPhase(5), 7000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const riskWords = ["Overpaying", "Fake Listings", "iCloud Locks", "Scams"];

  return (
    <motion.div 
      className="absolute inset-0 flex items-center overflow-hidden pl-[10vw]"
      initial={{ opacity: 0, x: 100 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -100, filter: 'blur(5px)' }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="relative z-10 w-[40vw]">
        <motion.h2 
          className="text-[4vw] font-display font-bold leading-tight mb-8"
          initial={{ opacity: 0, y: 30 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
        >
          Buying used shouldn't feel like a gamble.
        </motion.h2>

        <div className="flex flex-col gap-4">
          {riskWords.map((word, i) => (
            <motion.div 
              key={word}
              className="flex items-center gap-4 text-[2vw] font-medium text-slate-300"
              initial={{ opacity: 0, x: -30 }}
              animate={phase >= 2 ? { opacity: 1, x: 0 } : {}}
              transition={{ delay: i * 0.2, duration: 0.5, type: "spring" }}
            >
              <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/50 flex items-center justify-center text-red-500">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </div>
              {word}
            </motion.div>
          ))}
        </div>
      </div>

      {/* Warning Graphic on the right */}
      <motion.div 
        className="absolute right-[10vw] w-[35vw] h-[35vw] border-[1px] border-red-500/30 rounded-full flex items-center justify-center"
        initial={{ scale: 0.5, opacity: 0, rotate: -45 }}
        animate={phase >= 3 ? { scale: 1, opacity: 1, rotate: 0 } : {}}
        transition={{ duration: 1.5, type: "spring", stiffness: 50 }}
      >
        <motion.div 
          className="w-[25vw] h-[25vw] border-[2px] border-red-500/50 rounded-full flex items-center justify-center bg-red-500/5"
          animate={{ scale: [1, 1.05, 1], opacity: [0.5, 0.8, 0.5] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <svg className="w-[10vw] h-[10vw] text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </motion.div>
      </motion.div>

    </motion.div>
  );
}
