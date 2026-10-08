/** Registry names become directory/file names and GitHub repository names. */
export function whyInvalidRegistryName(name: string): string | undefined {
  if (name === "." || name === ".." || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return "must contain only letters, digits, '-', '_', '.' and not be '.' or '..'";
  }
  return undefined;
}
