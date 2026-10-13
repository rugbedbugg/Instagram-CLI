/**
 * Offline mock imagery: 32x32 RGB gradient PNGs encoded as data URIs.
 *
 * Image components read sources with the global fetch, which resolves data
 * URIs without a socket and cannot be cancelled on unmount. Remote URLs here
 * made mock mode and UI tests depend on, and wait for, third-party hosts.
 */

export const sunsetImage =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAgElEQVR42rXNkRaDUAAA0N4+aR82GAyCQTAIBsEgCIIgCILBIAiCYBAEg0Ew6CfevuKec/2GeDomycEJ8ayDiw5SHVx1kOngpoNcB3cdFDp46KDUQaWDWgeNDloddDrodfDUwUsHgw5GHUw6mHXw1sGig1UHHx18dbDp4KeD3QZ/FgxDgcgXlggAAAAASUVORK5CYII=';

export const oceanImage =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAgUlEQVR42rXNkRaDUAAA0N6+4X3YYDAIBsEgGARBEASDIAgGgyAIgsEgGAyCQbQv6ivuOddviMf/IUmcEE86OOsg1cFFB5kOrjrIdXDTQaGDUgeVDmodNDq466DVQaeDXgcPHTx1MOhg1MGkg1kHLx28dbDo4KODrw5WHfx0sNlgB/r/NmH1r3GnAAAAAElFTkSuQmCC';

export const forestImage =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAc0lEQVR42rXNYQaDYAAA0O9j50gySSaZJEmSSWZmJjOzg3T8TvF4/19M9iGcghNTHWQ6OOsg10Ghg1IHFx1UOqh1cNVBo4NWB50Oeh0MOhh1MOlg1sFNB4sOVh3cdfDQwVMHLx28dbDp4KODrw5+Ovjj4ADMni3B/4Zq3QAAAABJRU5ErkJggg==';

export const duskImage =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAApElEQVR42rXNYQbCAACA0Y0OkySTSZJkMslkMkmSmeznjjNiRESMMUaMiDFGjBERMSJiRBfoFB/v/xOdulsTBI7oNLZw0PTgoLWDA2kPB+0DHMhHOOj4cNAN4KAXwkE/goPBCQ6GMRwoZzgYXeBATeBgnMLBJIMD7QoH0xwO9AIOZjc4MO5wMH/AweIJB8sSDlYvOFi/4cD8wIFVwcHmCwf2Dw3+RC8+0YZKoNUAAAAASUVORK5CYII=';

export const mockImageUrls = [sunsetImage, oceanImage, forestImage, duskImage];
