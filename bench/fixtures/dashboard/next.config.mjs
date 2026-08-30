// `turbopack.root` pins the workspace root so Next never walks up out of the fixture.
export default { turbopack: { root: import.meta.dirname } }
