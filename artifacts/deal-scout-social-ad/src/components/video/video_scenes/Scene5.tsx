import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import storeLogo from "@assets/store_icon_128_1775856297061.png";

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ opacity: 1, clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0, clipPath: 'circle(0% at 50% 50%)' }}
      transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-950 via-slate-900 to-slate-950" />

      <div className="relative z-10 flex flex-col items-center">
        <motion.div
          className="w-[10vw] h-[10vw] bg-white rounded-3xl flex items-center justify-center p-4 shadow-[0_0_80px_rgba(16,185,129,0.5)] mb-8"
          initial={{ scale: 0, rotate: -180 }}
          animate={phase >= 1 ? { scale: 1, rotate: 0 } : { scale: 0, rotate: -180 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15 }}
        >
          <img src={storeLogo} className="w-full h-full object-contain" alt="Deal Scout" />
        </motion.div>

        <motion.h1
          className="text-[6vw] font-black text-white tracking-tighter leading-none"
          style={{ fontFamily: 'var(--font-display)' }}
          initial={{ opacity: 0, y: 40 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
          transition={{ duration: 0.6, type: 'spring' }}
        >
          Deal Scout
        </motion.h1>

        <motion.p
          className="text-[2vw] text-emerald-300/80 mt-4"
          initial={{ opacity: 0 }}
          animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.6 }}
        >
          Score every deal. Stay safe.
        </motion.p>

        <motion.div
          className="mt-6 px-6 py-3 bg-emerald-500/20 border border-emerald-500/50 rounded-full"
          initial={{ opacity: 0, y: 15 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 15 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <p className="text-[1.2vw] font-medium text-emerald-300">Free on Chrome Web Store</p>
        </motion.div>
      </div>

      <motion.div
        className="absolute w-[50vw] h-[50vw] rounded-full border border-emerald-500/10 pointer-events-none"
        animate={{ rotate: 360, scale: [1, 1.1, 1] }}
        transition={{ rotate: { duration: 25, repeat: Infinity, ease: 'linear' }, scale: { duration: 4, repeat: Infinity, ease: 'easeInOut' } }}
      />
    </motion.div>
  );
}
