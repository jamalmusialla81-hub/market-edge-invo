(function(root){
  const CORE_INVO_INSTRUMENTS=['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','LINK','SUI','PENGU','BNB','LTC','DOT','NEAR','APT','ARB','OP','UNI','AAVE','INJ'];
  // Invo sends this Hyperliquid instrument as kPEPE; Binance calls the same
  // 1,000-token contract 1000PEPE. The Invo instrument remains kPEPE.
  const DATA_SYMBOL_OVERRIDES={kPEPE:'1000PEPE'};
  function finite(value){const number=Number(value);return Number.isFinite(number)?number:0;}
  function build(metaAndAssetCtxs,{limit=40}={}){
    const meta=Array.isArray(metaAndAssetCtxs)?metaAndAssetCtxs[0]:null;
    const contexts=Array.isArray(metaAndAssetCtxs)?metaAndAssetCtxs[1]:null;
    const universe=Array.isArray(meta?.universe)?meta.universe:[];
    if(!universe.length||!Array.isArray(contexts))throw new Error('Invo instrument source returned no perpetual universe');
    const eligible=universe.map((instrument,index)=>({
      invoInstrument:String(instrument?.name||''),
      dataSymbol:DATA_SYMBOL_OVERRIDES[String(instrument?.name||'')]||String(instrument?.name||''),
      maxLeverage:finite(instrument?.maxLeverage),
      dayNotionalVolume:finite(contexts[index]?.dayNtlVlm),
      openInterest:finite(contexts[index]?.openInterest),
      markPrice:finite(contexts[index]?.markPx),
      delisted:Boolean(instrument?.isDelisted)
    })).filter(market=>market.invoInstrument&&!market.delisted&&market.dayNotionalVolume>0&&market.markPrice>0);
    const byInstrument=new Map(eligible.map(market=>[market.invoInstrument,market]));
    const core=CORE_INVO_INSTRUMENTS.map(instrument=>byInstrument.get(instrument)).filter(Boolean);
    const coreSet=new Set(core.map(market=>market.invoInstrument));
    const extras=eligible.filter(market=>!coreSet.has(market.invoInstrument)).sort((a,b)=>b.dayNotionalVolume-a.dayNotionalVolume||b.openInterest-a.openInterest||a.invoInstrument.localeCompare(b.invoInstrument));
    const selected=[...core,...extras.slice(0,Math.max(0,limit-core.length))];
    return {
      source:'INVO LIVE HYPERLIQUID PERPETUALS',
      totalEligible:eligible.length,
      selected,
      excluded:Math.max(0,eligible.length-selected.length),
      coreMissing:CORE_INVO_INSTRUMENTS.filter(instrument=>!byInstrument.has(instrument))
    };
  }
  root.MarketEdgeInvoUniverse=Object.freeze({CORE_INVO_INSTRUMENTS,DATA_SYMBOL_OVERRIDES,build});
})(window);
