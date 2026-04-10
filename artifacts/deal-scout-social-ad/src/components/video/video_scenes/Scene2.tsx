import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import storeLogo from "@assets/store_icon_128_1775856297061.png";

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 2200),
      setTimeout(() => setPhase(4), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ opacity: 1, clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0, x: -100 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full h-full flex items-center px-[6vw]">
        <div className="w-[55%] flex flex-col">
          <motion.div
            className="flex items-center gap-4 mb-6"
            initial={{ opacity: 0, x: -40 }}
            animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -40 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          >
            <img src={storeLogo} className="w-[4vw] h-[4vw] rounded-xl" alt="Deal Scout" />
            <span className="text-[1.8vw] font-bold text-white" style={{ fontFamily: 'var(--font-display)' }}>
              Deal Scout
            </span>
          </motion.div>

          <motion.h2
            className="text-[4.5vw] font-black text-white leading-[0.95] tracking-tight"
            style={{ fontFamily: 'var(--font-display)' }}
            initial={{ opacity: 0, y: 40 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            AI Scores
            <br />
            <span className="text-emerald-400">Every Deal</span>
          </motion.h2>

          <motion.p
            className="text-[1.3vw] text-slate-400 mt-4 max-w-[30vw]"
            initial={{ opacity: 0 }}
            animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.5 }}
          >
            Instant 1-10 scores powered by real eBay sold prices
          </motion.p>
        </div>

        <motion.div
          className="w-[40%] flex items-center justify-center"
          initial={{ opacity: 0, scale: 0.5, rotate: -10 }}
          animate={phase >= 2 ? { opacity: 1, scale: 1, rotate: 0 } : { opacity: 0, scale: 0.5, rotate: -10 }}
          transition={{ type: 'spring', stiffness: 200, damping: 18 }}
        >
          <motion.div
            className="w-[14vw] h-[14vw] rounded-full bg-emerald-500 shadow-[0_0_60px_rgba(16,185,129,0.4)] flex flex-col items-center justify-center"
            animate={phase >= 2 ? { scale: [1, 1.05, 1] } : {}}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <span className="text-[1vw] font-bold text-emerald-950 uppercase tracking-widest">Score</span>
            <motion.span
              className="text-[6vw] font-black text-white leading-none"
              initial={{ opacity: 0, scale: 0 }}
              animate={phase >= 3 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 15 }}
            >
              9.2
            </motion.span>
          </motion.div>
        </motion.div>
      </div>
    </motion.div>
  );
}
