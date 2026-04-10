import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 2000),
      setTimeout(() => setPhase(3), 3500),
      setTimeout(() => setPhase(4), 6500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
      transition={{ duration: 0.8 }}
    >
      
      {/* Midground: Floating Mock Cards representing listings */}
      <div className="absolute inset-0 perspective-[1000px] flex items-center justify-center pointer-events-none">
        {[
          { text: "$1,200 MacBook Pro M2?", x: "-25vw", y: "-15vh", z: -100, rotate: -15, delay: 0.2 },
          { text: "PS5 for $250 - Too Good?", x: "30vw", y: "-20vh", z: -50, rotate: 10, delay: 0.4 },
          { text: "Honda Civic - Clean Title?", x: "-30vw", y: "25vh", z: 50, rotate: 5, delay: 0.6 },
          { text: "Rolex - Real or Fake?", x: "25vw", y: "20vh", z: 0, rotate: -8, delay: 0.8 },
        ].map((card, i) => (
          <motion.div
            key={i}
            className="absolute p-4 rounded-xl bg-slate-800/80 backdrop-blur-md border border-slate-700/50 shadow-2xl font-body text-slate-300 text-[1.2vw] whitespace-nowrap"
            initial={{ opacity: 0, x: card.x, y: `calc(${card.y} + 50px)`, z: card.z - 200, rotateY: card.rotate, rotateX: 20 }}
            animate={phase >= 1 ? { opacity: 0.5, y: card.y, z: card.z, rotateX: 0 } : {}}
            transition={{ type: "spring", stiffness: 100, damping: 20, delay: card.delay }}
          >
            {card.text}
          </motion.div>
        ))}
      </div>

      {/* Foreground Typography */}
      <div className="relative z-10 text-center flex flex-col items-center">
        <motion.div
          className="overflow-hidden mb-4"
          initial={{ height: 0 }}
          animate={phase >= 2 ? { height: 'auto' } : {}}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="text-[1.8vw] text-slate-400 font-medium tracking-wide uppercase">Used Marketplaces</p>
        </motion.div>

        <h1 className="text-[7vw] font-display font-black leading-[1.1] tracking-tighter">
          <motion.span 
            className="block text-transparent bg-clip-text bg-gradient-to-r from-white to-slate-400"
            initial={{ y: 100, opacity: 0 }}
            animate={phase >= 2 ? { y: 0, opacity: 1 } : {}}
            transition={{ type: "spring", stiffness: 200, damping: 25, delay: 0.1 }}
          >
            Great Deals.
          </motion.span>
          <motion.span 
            className="block text-red-500"
            initial={{ y: 100, opacity: 0 }}
            animate={phase >= 3 ? { y: 0, opacity: 1 } : {}}
            transition={{ type: "spring", stiffness: 200, damping: 25, delay: 0.2 }}
          >
            Massive Risk.
          </motion.span>
        </h1>
      </div>
    </motion.div>
  );
}
