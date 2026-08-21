export {};

const child = Bun.spawn(['sh', '-c', 'sleep 300'], {
  stdout: 'ignore',
  stderr: 'ignore',
});
console.log(child.pid);
await new Promise(() => {});
