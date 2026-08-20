/// <reference types="vite/client" />

// File System Access API: the handle types are already in lib.dom, but the
// Window.showDirectoryPicker entry point isn't yet.
interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
