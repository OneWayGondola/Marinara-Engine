export const MARINARA_UNIVERSAL_PRESET_ARTWORK = "/illustrations/marinara-universal-preset.webp";

const MARINARA_UNIVERSAL_PRESET_NAME = "Marinara's Universal Preset";
const MARINARA_UNIVERSAL_PRESET_AUTHOR = "Marinara";

export function resolvePresetArtwork(preset: {
  name: string;
  author?: string | null;
  imagePath?: string | null;
}): string | null {
  if (preset.imagePath) return preset.imagePath;
  if (preset.name === MARINARA_UNIVERSAL_PRESET_NAME && preset.author === MARINARA_UNIVERSAL_PRESET_AUTHOR) {
    return MARINARA_UNIVERSAL_PRESET_ARTWORK;
  }
  return null;
}
