import discoveredPackages from 'virtual:open-artifacts-artifact-packages';
import type { ComponentType } from 'react';

type RenderComponent = ComponentType<{ data: unknown }>;

interface ArtifactManifest {
  name: string;
  version: string;
  description: string;
  dependencies?: Record<string, string>;
  openArtifacts: {
    format: string;
  };
}

export interface ArtifactPackage {
  directory: string;
  slug: string;
  title: string;
  name: string;
  version: string;
  description: string;
  format: string;
  dependencies: string[];
  sourceFiles: string[];
  schemaTitle: string;
  example: unknown;
  Render: RenderComponent;
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireManifest(value: unknown, directory: string): ArtifactManifest {
  const manifest = requireRecord(value, `${directory}/package.json`);
  const openArtifacts = requireRecord(manifest.openArtifacts, `${directory}.openArtifacts`);

  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.description !== 'string' ||
    typeof openArtifacts.format !== 'string'
  ) {
    throw new Error(`${directory}/package.json is missing Artifact Package metadata`);
  }

  return manifest as unknown as ArtifactManifest;
}

function slugFromDirectory(directory: string): string {
  if (!directory.startsWith('artifact-')) {
    throw new Error(`${directory} must use the artifact- package prefix`);
  }
  return directory.slice('artifact-'.length);
}

export const artifactPackages: ArtifactPackage[] = discoveredPackages.map((candidate) => {
  const manifest = requireManifest(candidate.manifest, candidate.directory);
  const schema = requireRecord(candidate.schema, `${candidate.directory} input schema`);
  const slug = slugFromDirectory(candidate.directory);

  return {
    directory: candidate.directory,
    slug,
    title: titleFromSlug(slug),
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    format: manifest.openArtifacts.format,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    sourceFiles: [
      'package.json',
      'src/index.tsx',
      'input.schema.json',
      'example.json',
      'tsconfig.json',
    ],
    schemaTitle: typeof schema.title === 'string' ? schema.title : 'JSON Schema',
    example: candidate.example,
    Render: candidate.Render,
  };
});
