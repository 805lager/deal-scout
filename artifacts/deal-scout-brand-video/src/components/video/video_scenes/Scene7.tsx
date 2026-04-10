import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import storeLogo from "@assets/store_icon_128_1775856297061.png";

export function Scene7() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
      setTimeout(() => setPhase(4), 4500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ opacity: 1, clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-950 via-slate-900 to-slate-950" />

      <div className="relative z-10 flex flex-col items-center">
        <motion.div
          className="w-[12vw] h-[12vw] bg-white rounded-3xl flex items-center justify-center p-6 shadow-[0_0_80px_rgba(16,185,129,0.4)] mb-12"
          initial={{ scale: 0, rotate: -180 }}
          animate={phase >= 1 ? { scale: 1, rotate: 0 } : { scale: 0, rotate: -180 }}
          transition={{ type: "spring", stiffness: 150, damping: 15 }}
        >
          <img src={storeLogo} className="w-full h-full object-contain" alt="Deal Scout" />
        </motion.div>

        <motion.h1
          className="text-[8vw] font-black text-white tracking-tighter leading-none"
          style={{ fontFamily: 'var(--font-display)' }}
          initial={{ opacity: 0, y: 50 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
          transition={{ duration: 0.8, type: "spring" }}
        >
          Score Every Deal.
        </motion.h1>

        <motion.p
          className="text-[1.8vw] text-emerald-300/80 mt-6"
          initial={{ opacity: 0 }}
          animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.8 }}
        >
          AI-powered deal scoring for used marketplaces
        </motion.p>

        <motion.div
          className="mt-8 px-8 py-4 bg-emerald-500/20 border border-emerald-500/50 rounded-full"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          <p className="text-[1.3vw] font-medium text-emerald-300">Available on Chrome Web Store</p>
        </motion.div>
      </div>

      <motion.div
        className="absolute w-[60vw] h-[60vw] rounded-full border border-emerald-500/10 pointer-events-none"
        animate={{ rotate: 360, scale: [1, 1.1, 1] }}
        transition={{ rotate: { duration: 30, repeat: Infinity, ease: "linear" }, scale: { duration: 4, repeat: Infinity, ease: "easeInOut" } }}
      />
      <motion.div
        className="absolute w-[80vw] h-[80vw] rounded-full border border-emerald-500/5 pointer-events-none"
        animate={{ rotate: -360 }}
        transition={{ duration: 45, repeat: Infinity, ease: "linear" }}
      />
    </motion.div>
  );
}
