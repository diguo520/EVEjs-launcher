/**
 * three 这个包不发布 .d.ts（package.json 里没有 types 字段，也没有随包声明），
 * 而 star-map-fx.tsx / boot-three-fx.tsx 里是按 any 用的（几何 / 材质只在背景与开机画面里出现一次，
 * 为它引 @types/three 得不偿失 —— 那是又一个要跟着版本走的依赖）。
 *
 * 所以这里只补一句 ambient 声明。注意它不提供任何类型安全：
 * three 的 API 名写错只会在运行时暴露，改这两个文件后必须真机看一眼。
 */
declare module "three"
