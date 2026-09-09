from __future__ import annotations
import argparse
import json
from pathlib import Path
from .client import CloudCabinetClient, CabinetError

def main():
    parser = argparse.ArgumentParser(prog='python -m desktop')
    parser.add_argument('--url', required=True)
    parser.add_argument('--token', required=True)
    parser.add_argument('--cache', default='~/.cache/cloud-cabinet')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('probe')
    mount_parser = sub.add_parser('mount')
    mount_parser.add_argument('mountpoint')
    upload = sub.add_parser('upload')
    upload.add_argument('file')
    upload.add_argument('--parent', default='root')
    upload.add_argument('--mime', default='application/octet-stream')
    upload.add_argument('--entry-id')
    upload.add_argument('--base-version')
    upload.add_argument('--state')
    args = parser.parse_args()
    try:
        client = CloudCabinetClient(args.url, Path(args.token).expanduser(), Path(args.cache).expanduser())
        if args.cmd == 'probe':
            print(json.dumps({'entries': len(client.entries())}))
        elif args.cmd == 'mount':
            from .fuse_mount import mount
            mount(client, args.mountpoint)
        else:
            if bool(args.entry_id) != bool(args.base_version):
                parser.error('revisions require both --entry-id and --base-version')
            result = client.upload_multipart(args.file, args.parent, args.mime, args.state, args.entry_id, args.base_version)
            print(json.dumps(result, indent=2))
    except (CabinetError, OSError, ValueError) as exc:
        parser.exit(1, f'Cloud Cabinet: {exc}\n')

if __name__ == '__main__':
    main()
