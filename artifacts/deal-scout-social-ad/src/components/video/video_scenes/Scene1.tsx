import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'polygon(50% 0%, 50% 0%, 50% 100%, 50% 100%)' }}
      animate={{ opacity: 1, clipPath: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)' }}
      exit={{ opacity: 0, scale: 1.3, filter: 'blur(20px)' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="absolute top-[15%] left-[10%] w-[6vw] h-[6vw] rounded-full border border-red-500/20"
        animate={{ y: [0, -10, 0], rotate: [0, 180, 360] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 text-center px-[8vw]">
        <motion.div
          className="flex items-center justify-center gap-4 mb-6"
          initial={{ opacity: 0, scale: 0 }}
          animate={phase >= 1 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        >
          <motion.div
            className="w-[5vw] h-[5vw] rounded-xl bg-red-500/20 border border-red-500/40 flex items-center justify-center"
            animate={phase >= 1 ? { rotate: [0, -5, 5, 0] } : {}}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-[2.5vw] h-[2.5vw]">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </motion.div>
        </motion.div>

        <motion.h1
          className="text-[7vw] font-black text-white leading-[0.9] tracking-tighter"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {'STOP'.split('').map((char, i) => (
            <motion.span
              key={i}
              style={{ display: 'inline-block' }}
              initial={{ opacity: 0, y: 80, rotateX: -60 }}
              animate={phase >= 2 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 80, rotateX: -60 }}
              transition={{ type: 'spring', stiffness: 500, damping: 25, delay: phase >= 2 ? i * 0.06 : 0 }}
            >
              {char}
            </motion.span>
          ))}
        </motion.h1>

        <motion.p
          className="text-[2.5vw] text-red-400 font-semibold mt-4 tracking-wide"
          style={{ fontFamily: 'var(--font-display)' }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.4 }}
        >
          GETTING SCAMMED.
        </motion.p>
      </div>
    </motion.div>
  );
}
