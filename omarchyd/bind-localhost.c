/* A published solver binds 0.0.0.0. Loaded into that process only, this turns a
 * wildcard bind into localhost so other containers cannot skip the token proxy.
 * The proxy itself does not load it, or its LAN port would be unreachable.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>

int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
	static int (*real_bind)(int, const struct sockaddr *, socklen_t);
	if (!real_bind)
		real_bind = (int (*)(int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "bind");
	if (addr && addr->sa_family == AF_INET && addrlen >= (socklen_t)sizeof(struct sockaddr_in)) {
		struct sockaddr_in copy;
		memcpy(&copy, addr, sizeof(copy));
		if (copy.sin_addr.s_addr == htonl(INADDR_ANY)) {
			copy.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
			return real_bind(sockfd, (struct sockaddr *)&copy, addrlen);
		}
	}
	if (addr && addr->sa_family == AF_INET6 && addrlen >= (socklen_t)sizeof(struct sockaddr_in6)) {
		struct sockaddr_in6 copy;
		memcpy(&copy, addr, sizeof(copy));
		if (IN6_IS_ADDR_UNSPECIFIED(&copy.sin6_addr)) {
			copy.sin6_addr = in6addr_loopback;
			return real_bind(sockfd, (struct sockaddr *)&copy, addrlen);
		}
	}
	return real_bind(sockfd, addr, addrlen);
}
