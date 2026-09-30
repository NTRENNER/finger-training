import fs from 'fs';
import path from 'path';
import {parse} from '@babel/parser';

// Shared measurement/context utilities may feed forecasts. Descriptive trends,
// exposure displays and retrospective experiments must never feed prescription.
// Walk transitive imports so an intermediate helper cannot evade the boundary.
const modelDir=path.resolve(__dirname,'..');
const analysis=new Set(['performanceTrends','contextualTrendFit','contextualTrendEvaluation',
  'trainingExposure','historicalEvaluation','forwardEvaluation','capacityTrendExperiment',
  'adaptiveCapacityExperiment','adaptiveCapacityEvaluation','capacityWindowExperiment']
  .map(name=>path.join(modelDir,`${name}.js`)));
const roots=['prescription','load','deload','densityLadder','setRecommendation','coaching',
  'mixedLoadPrescription','workout-progression'];
function dependencies(source){
 const found=[];
 const visit=node=>{
  if(!node || typeof node!=='object')return;
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type) && node.source) found.push(node.source.value);
  if(node.type==='CallExpression' && (node.callee?.type==='Import' || node.callee?.name==='require') && node.arguments[0]?.type==='StringLiteral')found.push(node.arguments[0].value);
  Object.values(node).forEach(value=>Array.isArray(value)?value.forEach(visit):visit(value));
 };
 visit(parse(source,{sourceType:'unambiguous',plugins:['jsx']}));
 return found.filter(name=>name.startsWith('.'));
}
function violations(root,read=filename=>fs.readFileSync(filename,'utf8')){
 const seen=new Set(),bad=[];
 const walk=(file,chain)=>{
  if(analysis.has(file)){bad.push([...chain,path.basename(file)].join(' -> '));return;}
  if(seen.has(file))return;
  seen.add(file);
  for(const spec of dependencies(read(file))){
   const base=path.resolve(path.dirname(file),spec);
   const next=[base,base+'.js',base+'.jsx',path.join(base,'index.js')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
   if(next && /\.jsx?$/.test(next))walk(next,[...chain,path.basename(file)]);
  }
 };
 walk(root,[]);return bad;
}
test.each(roots)('%s has no direct or indirect dependency on analysis experiments',name=>{
 expect(violations(path.join(modelDir,`${name}.js`))).toEqual([]);
});
test('the boundary catches an indirect import through an otherwise allowed helper',()=>{
 const root=path.join(modelDir,'prescription.js'),helper=path.join(modelDir,'load.js');
 const read=file=>file===root?"export * from './load.js';":file===helper?"const x = require('./performanceTrends.js');":fs.readFileSync(file,'utf8');
 expect(violations(root,read)).toEqual(['prescription.js -> load.js -> performanceTrends.js']);
});
