import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import storeLogo from "@assets/store_icon_128_1775856297061.png";

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 2000),
      setTimeout(() => setPhase(3), 3500),
      setTimeout(() => setPhase(4), 5500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, y: -100 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div 
        className="w-[15vw] h-[15vw] bg-white rounded-3xl shadow-[0_0_100px_rgba(16,185,129,0.3)] flex items-center justify-center p-8 mb-8"
        initial={{ y: 50, opacity: 0, rotateX: 45 }}
        animate={phase >= 1 ? { y: 0, opacity: 1, rotateX: 0 } : {}}
        transition={{ type: "spring", stiffness: 200, damping: 20 }}
      >
        <img src={storeLogo} className="w-full h-full object-contain" alt="Deal Scout Logo" />
      </motion.div>

      <motion.h1 
        className="text-[6vw] font-display font-black text-white tracking-tight"
        initial={{ opacity: 0, y: 20 }}
        animate={phase >= 2 ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6 }}
      >
        Meet Deal Scout
      </motion.h1>

      <motion.p 
        className="text-[2vw] text-emerald-400 font-medium"
        initial={{ opacity: 0 }}
        animate={phase >= 3 ? { opacity: 1 } : {}}
        transition={{ duration: 0.8 }}
      >
        AI that scores every deal for you.
      </motion.p>
    </motion.div>
  );
}
