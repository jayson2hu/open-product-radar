/** Without an explicit edition choice, distinct scoped facts must not collapse
 * into the first stored assertion (which can describe the opposite edition). */
export function comparisonCell(entity, dimension) {
  const facts=(entity.assertions||[]).filter(assertion=>assertion.dimension===dimension);
  if(!facts.length)return {entity_id:entity.id,status:'unknown',value:'暂无可核查证据',scope:'未确认适用版本或套餐',evidence_ids:[]};
  const variants=[...new Map(facts.map(fact=>[JSON.stringify([fact.status,fact.value,fact.scope]),fact])).values()];
  const evidenceIds=[...new Set(facts.flatMap(fact=>fact.evidence_ids||[]))];
  if(variants.length===1){const fact=variants[0];return {entity_id:entity.id,status:fact.status,value:fact.value,scope:fact.scope,evidence_ids:evidenceIds};}
  const scopes=[...new Set(variants.map(fact=>fact.scope).filter(Boolean))];
  return {entity_id:entity.id,status:'unknown',value:'存在多条不同判断，请先核对版本、套餐与适用范围',
    scope:scopes.slice(0,3).join('；')+(scopes.length>3?`；另有${scopes.length-3}种范围`:''),evidence_ids:evidenceIds,
    variants:variants.map(({id,status,value,scope,evidence_ids})=>({id,status,value,scope,evidence_ids}))};
}
