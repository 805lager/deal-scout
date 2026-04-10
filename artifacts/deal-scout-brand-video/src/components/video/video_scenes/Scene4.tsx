import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene4() {
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

  const scamLayers = [
    { name: "Pattern Detection", desc: "Zelle/Venmo requests, off-platform scams", color: "#EF4444" },
    { name: "AI Analysis", desc: "Subtle manipulation & pressure tactics", color: "#F59E0B" },
    { name: "Item-Specific Risks", desc: "iCloud locks, VIN issues, counterfeits", color: "#10B981" },
  ];

  return (
    <motion.div
      className="absolute inset-0 flex items-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'polygon(50% 0%, 50% 0%, 50% 100%, 50% 100%)' }}
      animate={{ opacity: 1, clipPath: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)' }}
      exit={{ opacity: 0, x: -80 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full h-full flex">
        <div className="w-[50vw] flex flex-col justify-center pl-[8vw] pr-[4vw]">
          <motion.h2
            className="text-[3.5vw] font-bold leading-tight mb-8"
            style={{ fontFamily: 'var(--font-display)' }}
            initial={{ opacity: 0, y: 30 }}
            animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
            transition={{ duration: 0.7 }}
          >
            AI-Powered Scoring
          </motion.h2>

          <motion.div
            className="flex items-center gap-6 mb-10"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={phase >= 2 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.8 }}
            transition={{ type: "spring", stiffness: 200, damping: 20 }}
          >
            <motion.div
              className="w-[8vw] h-[8vw] rounded-full bg-emerald-500 shadow-[0_0_40px_rgba(16,185,129,0.5)] flex flex-col items-center justify-center"
              animate={phase >= 2 ? { scale: [1, 1.05, 1] } : {}}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <span className="text-[0.8vw] font-bold text-emerald-950 uppercase tracking-widest">Deal Score</span>
              <span className="text-[3.5vw] font-black text-white leading-none">8.5</span>
            </motion.div>
            <div>
              <p className="text-[1.5vw] text-white font-semibold">Every listing scored 1-10</p>
              <p className="text-[1.1vw] text-slate-400 mt-1">Price analysis + market comps + AI vision</p>
            </div>
          </motion.div>

          <motion.div
            className="flex items-center gap-4 mb-4"
            initial={{ opacity: 0 }}
            animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="w-[3vw] h-[0.3vh] bg-emerald-500 rounded-full" />
            <span className="text-[1.3vw] text-emerald-400 font-medium uppercase tracking-wider">vs. Real eBay Sold Prices</span>
          </motion.div>

          <motion.p
            className="text-[1.2vw] text-slate-400 leading-relaxed max-w-[35vw]"
            initial={{ opacity: 0 }}
            animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            Compares every listing against actual completed eBay transactions to determine true market value.
          </motion.p>
        </div>

        <div className="w-[50vw] flex flex-col justify-center pr-[8vw] pl-[2vw]">
          <motion.h3
            className="text-[2.5vw] font-bold mb-6"
            style={{ fontFamily: 'var(--font-display)' }}
            initial={{ opacity: 0, y: 20 }}
            animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.6 }}
          >
            3-Layer Scam Detection
          </motion.h3>

          <div className="flex flex-col gap-5">
            {scamLayers.map((layer, i) => (
              <motion.div
                key={layer.name}
                className="flex items-center gap-5 rounded-xl p-5 border backdrop-blur-md"
                style={{
                  backgroundColor: `${layer.color}08`,
                  borderColor: `${layer.color}30`
                }}
                initial={{ opacity: 0, x: 40 }}
                animate={phase >= i + 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: 40 }}
                transition={{ type: "spring", stiffness: 200, damping: 20 }}
              >
                <motion.div
                  className="w-[3.5vw] h-[3.5vw] rounded-full flex items-center justify-center text-[1.5vw] font-black shrink-0"
                  style={{ backgroundColor: `${layer.color}20`, color: layer.color }}
                  animate={phase >= i + 3 ? { scale: [0.8, 1.1, 1] } : {}}
                  transition={{ duration: 0.5 }}
                >
                  {i + 1}
                </motion.div>
                <div>
                  <p className="text-[1.3vw] font-bold text-white">{layer.name}</p>
                  <p className="text-[0.9vw] text-slate-400 mt-1">{layer.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
