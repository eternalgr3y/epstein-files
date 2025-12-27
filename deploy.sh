#!/bin/bash
set -e

# Epstein Files Deployment Script
# Usage: ./deploy.sh [init|update|ssl|logs|backup]

DOMAIN="${DOMAIN:-epsteinfiles.org}"
EMAIL="${CERTBOT_EMAIL:-admin@$DOMAIN}"

case "$1" in
    init)
        echo "=== Initial Deployment ==="

        # Check for .env
        if [ ! -f .env ]; then
            echo "Creating .env from template..."
            cp .env.example .env
            echo "Please edit .env with your settings, then run: ./deploy.sh init"
            exit 1
        fi

        # Create directories
        mkdir -p nginx/ssl certbot/conf certbot/www

        # Create temporary self-signed cert for initial nginx start
        if [ ! -f nginx/ssl/temp.crt ]; then
            echo "Creating temporary SSL certificate..."
            openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
                -keyout nginx/ssl/temp.key \
                -out nginx/ssl/temp.crt \
                -subj "/CN=$DOMAIN"
        fi

        # Create temporary nginx config for Let's Encrypt
        cat > nginx/nginx-init.conf << 'EOF'
events { worker_connections 1024; }
http {
    server {
        listen 80;
        server_name $DOMAIN www.$DOMAIN;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 200 'OK'; }
    }
}
EOF
        sed -i "s/\$DOMAIN/$DOMAIN/g" nginx/nginx-init.conf

        echo "Building application..."
        docker compose build

        echo "Starting nginx for SSL verification..."
        docker compose up -d nginx

        echo "Requesting SSL certificate..."
        docker compose run --rm certbot certonly --webroot \
            --webroot-path=/var/www/certbot \
            --email $EMAIL \
            --agree-tos \
            --no-eff-email \
            -d $DOMAIN -d www.$DOMAIN

        echo "Starting all services..."
        docker compose down
        docker compose up -d

        echo ""
        echo "=== Deployment Complete ==="
        echo "Site: https://$DOMAIN"
        echo ""
        ;;

    update)
        echo "=== Updating Application ==="
        git pull
        docker compose build
        docker compose up -d
        echo "Update complete!"
        ;;

    ssl)
        echo "=== Renewing SSL Certificate ==="
        docker compose run --rm certbot renew
        docker compose exec nginx nginx -s reload
        echo "SSL renewed!"
        ;;

    logs)
        docker compose logs -f --tail=100
        ;;

    backup)
        echo "=== Creating Backup ==="
        BACKUP_FILE="backup-$(date +%Y%m%d-%H%M%S).tar.gz"
        tar -czf $BACKUP_FILE database/
        echo "Backup created: $BACKUP_FILE"
        ;;

    stop)
        docker compose down
        echo "Services stopped."
        ;;

    start)
        docker compose up -d
        echo "Services started."
        ;;

    *)
        echo "Epstein Files Deployment"
        echo ""
        echo "Usage: $0 {init|update|ssl|logs|backup|start|stop}"
        echo ""
        echo "Commands:"
        echo "  init    - First-time deployment with SSL setup"
        echo "  update  - Pull latest code and restart"
        echo "  ssl     - Renew SSL certificates"
        echo "  logs    - View application logs"
        echo "  backup  - Create database backup"
        echo "  start   - Start all services"
        echo "  stop    - Stop all services"
        ;;
esac
