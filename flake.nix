{
  description = "Development shell for pi-callscript";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ bun nodejs_24 git gh lefthook ripgrep ];
            shellHook = ''
              lefthook install >/dev/null 2>&1 || true
            '';
          };
        });
    };
}
