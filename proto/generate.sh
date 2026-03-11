#!/bin/bash
# Generate gRPC client code from proto definitions
#
# Usage:
#   ./proto/generate.sh [python|typescript|all]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROTO_DIR="$ROOT_DIR/proto"

generate_python() {
    echo "Generating Python client..."
    
    PYTHON_OUT="$ROOT_DIR/packages/python/src/abbenay_grpc"
    mkdir -p "$PYTHON_OUT/abbenay/v1"
    
    python -m grpc_tools.protoc \
        -I "$PROTO_DIR" \
        --python_out="$PYTHON_OUT" \
        --pyi_out="$PYTHON_OUT" \
        --grpc_python_out="$PYTHON_OUT" \
        "$PROTO_DIR/abbenay/v1/service.proto"
    
    # Create __init__.py files
    touch "$PYTHON_OUT/abbenay/__init__.py"
    touch "$PYTHON_OUT/abbenay/v1/__init__.py"
    
    echo "Python client generated at $PYTHON_OUT"
}

generate_typescript() {
    echo "Generating TypeScript client..."
    
    # Generate to a shared location that both node and vscode can use
    TS_OUT="$ROOT_DIR/packages/proto-ts/src"
    mkdir -p "$TS_OUT"
    
    # Check for protoc
    if ! command -v protoc &> /dev/null; then
        echo "Error: protoc not found. Install protobuf compiler."
        exit 1
    fi
    
    # Use ts-proto for nice TypeScript output
    # Check if ts-proto is installed locally
    TS_PROTO_PLUGIN="$ROOT_DIR/node_modules/.bin/protoc-gen-ts_proto"
    if [ ! -f "$TS_PROTO_PLUGIN" ]; then
        echo "Installing ts-proto..."
        cd "$ROOT_DIR" && npm install ts-proto @grpc/grpc-js nice-grpc nice-grpc-client-middleware-deadline
    fi
    
    protoc \
        --plugin="protoc-gen-ts_proto=$TS_PROTO_PLUGIN" \
        --ts_proto_out="$TS_OUT" \
        --ts_proto_opt=outputServices=nice-grpc \
        --ts_proto_opt=outputServices=generic-definitions \
        --ts_proto_opt=useExactTypes=false \
        --ts_proto_opt=esModuleInterop=true \
        --ts_proto_opt=env=node \
        --ts_proto_opt=forceLong=long \
        --ts_proto_opt=oneof=unions \
        -I "$PROTO_DIR" \
        "$PROTO_DIR/abbenay/v1/service.proto"
    
    echo "TypeScript client generated at $TS_OUT"
    
    # Copy to vscode extension
    VSCODE_PROTO="$ROOT_DIR/packages/vscode/src/proto"
    mkdir -p "$VSCODE_PROTO"
    cp -r "$TS_OUT"/* "$VSCODE_PROTO/"
    echo "Copied to VS Code extension at $VSCODE_PROTO"
}

case "${1:-all}" in
    python)
        generate_python
        ;;
    typescript|ts)
        generate_typescript
        ;;
    all)
        generate_python
        generate_typescript
        ;;
    *)
        echo "Usage: $0 [python|typescript|all]"
        exit 1
        ;;
esac

echo "Done!"
